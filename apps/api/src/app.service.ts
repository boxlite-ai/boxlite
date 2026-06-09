/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { DockerRegistryService } from './docker-registry/services/docker-registry.service'
import { RegistryType } from './docker-registry/enums/registry-type.enum'
import { DockerRegistry } from './docker-registry/entities/docker-registry.entity'
import { OrganizationService } from './organization/services/organization.service'
import { UserService } from './user/user.service'
import { ApiKeyService } from './api-key/api-key.service'
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter'
import { BoxTemplateService } from './sandbox/services/box-template.service'
import { SystemRole } from './user/enums/system-role.enum'
import { TypedConfigService } from './config/typed-config.service'
import { SchedulerRegistry } from '@nestjs/schedule'
import { RegionService } from './region/services/region.service'
import { RunnerService } from './sandbox/services/runner.service'
import { RunnerAdapterFactory } from './sandbox/runner-adapter/runnerAdapter'
import { RegionType } from './region/enums/region-type.enum'
import { RunnerState } from './sandbox/enums/runner-state.enum'
import { resolveSystemTemplateName, SYSTEM_TEMPLATES } from './sandbox/constants/system-templates'

export const BOXLITE_ADMIN_USER_ID = 'boxlite-admin'

@Injectable()
export class AppService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AppService.name)

  constructor(
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly configService: TypedConfigService,
    private readonly userService: UserService,
    private readonly organizationService: OrganizationService,
    private readonly apiKeyService: ApiKeyService,
    private readonly eventEmitterReadinessWatcher: EventEmitterReadinessWatcher,
    private readonly boxTemplateService: BoxTemplateService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly regionService: RegionService,
    private readonly runnerService: RunnerService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
  ) {}

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Received shutdown signal: ${signal}. Shutting down gracefully...`)
    await this.stopAllCronJobs()
  }

  async onApplicationBootstrap() {
    if (this.configService.get('disableCronJobs') || this.configService.get('maintananceMode')) {
      await this.stopAllCronJobs()
    }

    await this.eventEmitterReadinessWatcher.waitUntilReady()

    await this.initializeDefaultRegion()
    await this.initializeAdminUser()
    await this.initializeTransientRegistry()
    await this.initializeBackupRegistry()
    await this.initializeInternalRegistry()
    await this.initializeBackupRegistry()
    await this.initializeSystemSourceRegistry()

    // Default runner init is not awaited because v2 runners depend on the API to be ready
    this.initializeDefaultRunner()
      .then(() => this.initializeSystemTemplates())
      .catch((error) => {
        this.logger.error('Error initializing default runner', error)
      })
  }

  private async stopAllCronJobs(): Promise<void> {
    for (const cronName of this.schedulerRegistry.getCronJobs().keys()) {
      this.logger.debug(`Stopping cron job: ${cronName}`)
      this.schedulerRegistry.deleteCronJob(cronName)
    }
  }

  private async initializeDefaultRegion(): Promise<void> {
    const existingRegion = await this.regionService.findOne(this.configService.getOrThrow('defaultRegion.id'))
    if (existingRegion) {
      return
    }

    this.logger.log('Initializing default region...')

    await this.regionService.create(
      {
        id: this.configService.getOrThrow('defaultRegion.id'),
        name: this.configService.getOrThrow('defaultRegion.name'),
        enforceQuotas: this.configService.getOrThrow('defaultRegion.enforceQuotas'),
        regionType: RegionType.SHARED,
      },
      null,
    )

    this.logger.log(`Default region created successfully: ${this.configService.getOrThrow('defaultRegion.name')}`)
  }

  private async initializeDefaultRunner(): Promise<void> {
    if (!this.configService.get('defaultRunner.name')) {
      return
    }

    const defaultRegionId = this.configService.getOrThrow('defaultRegion.id')

    const existingRunners = await this.runnerService.findAllByRegion(defaultRegionId)
    if (
      existingRunners.length > 0 &&
      existingRunners.some((r) => r.name === this.configService.get('defaultRunner.name'))
    ) {
      return
    }

    this.logger.log(`Creating default runner: ${this.configService.getOrThrow('defaultRunner.name')}`)

    const runnerVersion = this.configService.getOrThrow('defaultRunner.apiVersion')

    if (runnerVersion === '0') {
      const { runner } = await this.runnerService.create({
        apiUrl: this.configService.getOrThrow('defaultRunner.apiUrl'),
        proxyUrl: this.configService.getOrThrow('defaultRunner.proxyUrl'),
        apiKey: this.configService.getOrThrow('defaultRunner.apiKey'),
        cpu: this.configService.getOrThrow('defaultRunner.cpu'),
        memoryGiB: this.configService.getOrThrow('defaultRunner.memory'),
        diskGiB: this.configService.getOrThrow('defaultRunner.disk'),
        regionId: this.configService.getOrThrow('defaultRegion.id'),
        domain: this.configService.getOrThrow('defaultRunner.domain'),
        apiVersion: runnerVersion,
        name: this.configService.getOrThrow('defaultRunner.name'),
      })

      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      this.logger.log(`Waiting for runner ${runner.name} to be healthy...`)
      for (let i = 0; i < 30; i++) {
        try {
          await runnerAdapter.healthCheck()
          this.logger.log(`Runner ${runner.name} is healthy`)
          return
        } catch {
          // ignore
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } else if (runnerVersion === '2') {
      const { runner } = await this.runnerService.create({
        apiKey: this.configService.getOrThrow('defaultRunner.apiKey'),
        regionId: this.configService.getOrThrow('defaultRegion.id'),
        apiVersion: runnerVersion,
        name: this.configService.getOrThrow('defaultRunner.name'),
      })

      this.logger.log(`Waiting for runner ${runner.name} to be healthy...`)
      for (let i = 0; i < 30; i++) {
        const { state } = await this.runnerService.findOneFullOrFail(runner.id)
        if (state === RunnerState.READY) {
          this.logger.log(`Runner ${runner.name} is healthy`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    this.logger.log(
      `Default runner ${this.configService.getOrThrow('defaultRunner.name')} created successfully but didn't pass health check`,
    )
  }

  private async initializeAdminUser(): Promise<void> {
    let user = await this.userService.findOne(BOXLITE_ADMIN_USER_ID)
    if (!user) {
      user = await this.userService.create({
        id: BOXLITE_ADMIN_USER_ID,
        name: 'BoxLite Admin',
        personalOrganizationQuota: {
          totalCpuQuota: this.configService.getOrThrow('admin.totalCpuQuota'),
          totalMemoryQuota: this.configService.getOrThrow('admin.totalMemoryQuota'),
          totalDiskQuota: this.configService.getOrThrow('admin.totalDiskQuota'),
          maxCpuPerSandbox: this.configService.getOrThrow('admin.maxCpuPerSandbox'),
          maxMemoryPerSandbox: this.configService.getOrThrow('admin.maxMemoryPerSandbox'),
          maxDiskPerSandbox: this.configService.getOrThrow('admin.maxDiskPerSandbox'),
          templateQuota: this.configService.getOrThrow('admin.templateQuota'),
          maxTemplateSize: this.configService.getOrThrow('admin.maxTemplateSize'),
          volumeQuota: this.configService.getOrThrow('admin.volumeQuota'),
        },
        personalOrganizationDefaultRegionId: this.configService.getOrThrow('defaultRegion.id'),
        role: SystemRole.ADMIN,
      })
    }

    const personalOrg = await this.organizationService.findPersonal(user.id)
    await this.ensureAdminOrganizationQuota(personalOrg.id)
    const { value } = await this.apiKeyService.ensureApiKeyValue(
      personalOrg.id,
      user.id,
      BOXLITE_ADMIN_USER_ID,
      [],
      this.configService.getOrThrow('admin.apiKey'),
    )
    this.logger.log(
      `
=========================================
=========================================
Admin API key ensured: ${this.maskApiKeyForLog(value)}
=========================================
=========================================`,
    )
  }

  private async ensureAdminOrganizationQuota(organizationId: string): Promise<void> {
    await this.organizationService.updateQuota(organizationId, {
      maxCpuPerSandbox: this.configService.getOrThrow('admin.maxCpuPerSandbox'),
      maxMemoryPerSandbox: this.configService.getOrThrow('admin.maxMemoryPerSandbox'),
      maxDiskPerSandbox: this.configService.getOrThrow('admin.maxDiskPerSandbox'),
      templateQuota: this.configService.getOrThrow('admin.templateQuota'),
      maxTemplateSize: this.configService.getOrThrow('admin.maxTemplateSize'),
      volumeQuota: this.configService.getOrThrow('admin.volumeQuota'),
    })
  }

  private maskApiKeyForLog(value: string): string {
    if (value.length <= 8) {
      return '********'
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`
  }

  private async initializeTransientRegistry(): Promise<void> {
    const existingRegistry = await this.dockerRegistryService.getAvailableTransientRegistry(
      this.configService.getOrThrow('defaultRegion.id'),
    )
    await this.ensureConfiguredDefaultRegistry(existingRegistry, {
      name: 'Transient Registry',
      url: this.configService.get('transientRegistry.url') ?? '',
      username: this.configService.get('transientRegistry.admin') ?? '',
      password: this.configService.get('transientRegistry.password') ?? '',
      project: this.configService.get('transientRegistry.projectId') ?? '',
      registryType: RegistryType.TRANSIENT,
    })
  }

  private async initializeInternalRegistry(): Promise<void> {
    const existingRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(
      this.configService.getOrThrow('defaultRegion.id'),
    )
    await this.ensureConfiguredDefaultRegistry(existingRegistry, {
      name: 'Internal Registry',
      url: this.configService.get('internalRegistry.url') ?? '',
      username: this.configService.get('internalRegistry.admin') ?? '',
      password: this.configService.get('internalRegistry.password') ?? '',
      project: this.configService.get('internalRegistry.projectId') ?? '',
      registryType: RegistryType.INTERNAL,
    })
  }

  private async initializeBackupRegistry(): Promise<void> {
    const existingRegistry = await this.dockerRegistryService.getAvailableBackupRegistry(
      this.configService.getOrThrow('defaultRegion.id'),
    )
    await this.ensureConfiguredDefaultRegistry(existingRegistry, {
      name: 'Backup Registry',
      url: this.configService.get('internalRegistry.url') ?? '',
      username: this.configService.get('internalRegistry.admin') ?? '',
      password: this.configService.get('internalRegistry.password') ?? '',
      project: this.configService.get('internalRegistry.projectId') ?? '',
      registryType: RegistryType.BACKUP,
      isFallback: true,
    })
  }

  private async initializeSystemSourceRegistry(): Promise<void> {
    const url = this.configService.get('systemSourceRegistry.url') ?? ''
    const username = this.configService.get('systemSourceRegistry.username') ?? ''
    const password = this.configService.get('systemSourceRegistry.password') ?? ''
    if (!url || !username || !password) {
      this.logger.warn('System source registry configuration not found, skipping setup')
      return
    }

    const defaultRegionId = this.configService.getOrThrow('defaultRegion.id')
    const existingRegistry = await this.dockerRegistryService.findSourceRegistryByTemplateImageName(
      url,
      defaultRegionId,
      undefined,
    )
    const options = {
      name: this.configService.get('systemSourceRegistry.name') ?? 'BoxLite System Source Registry',
      url,
      username,
      password,
      project: this.configService.get('systemSourceRegistry.projectId') ?? '',
    }

    if (existingRegistry) {
      await this.dockerRegistryService.update(existingRegistry.id, options)
      this.logger.log(`System source registry updated: ${url}`)
      return
    }

    await this.dockerRegistryService.create({
      ...options,
      registryType: RegistryType.INTERNAL,
      isDefault: false,
    })
    this.logger.log(`System source registry initialized: ${url}`)
  }

  private async initializeSystemTemplates(): Promise<void> {
    const adminPersonalOrg = await this.organizationService.findPersonal(BOXLITE_ADMIN_USER_ID)

    const defaultTemplate = this.configService.getOrThrow('defaultTemplate')
    if (!resolveSystemTemplateName(defaultTemplate)) {
      this.logger.warn(`Configured default template ${defaultTemplate} is not in the system template list`)
    }

    for (const template of SYSTEM_TEMPLATES) {
      this.logger.log(`Ensuring system template: ${template.name}`)
      await this.boxTemplateService.ensureSystemTemplate(adminPersonalOrg, template)
    }
    await this.boxTemplateService.hideDeprecatedSystemTemplateAliases()

    this.logger.log('System templates initialized successfully')
  }

  private async ensureConfiguredDefaultRegistry(
    existingRegistry: DockerRegistry | null,
    options: {
      name: string
      url: string
      username: string
      password: string
      project: string
      registryType: RegistryType
      isFallback?: boolean
    },
  ): Promise<void> {
    if (!options.url || !options.username || !options.password || !options.project) {
      this.logger.warn(`Registry configuration not found, skipping ${options.name} setup`)
      return
    }

    if (existingRegistry) {
      const desiredUrl = this.normalizeRegistryUrl(options.url)
      const currentProject = existingRegistry.project ?? ''
      const desiredProject = options.project ?? ''

      if (
        existingRegistry.url !== desiredUrl ||
        existingRegistry.username !== options.username ||
        currentProject !== desiredProject ||
        existingRegistry.name !== options.name
      ) {
        this.logger.log(`Updating default ${options.name} configuration...`)
        await this.dockerRegistryService.update(existingRegistry.id, {
          name: options.name,
          url: options.url,
          username: options.username,
          password: options.password,
          project: options.project,
        })
      }

      return
    }

    this.logger.log(`Initializing default ${options.name}...`)

    await this.dockerRegistryService.create(
      {
        name: options.name,
        url: options.url,
        username: options.username,
        password: options.password,
        project: options.project,
        registryType: options.registryType,
        isDefault: true,
      },
      undefined,
      options.isFallback ?? false,
    )

    this.logger.log(`Default ${options.name} initialized successfully`)
  }

  private normalizeRegistryUrl(url: string): string {
    if (!url || url.trim() === '' || url.toLowerCase().includes('docker.io')) {
      return 'docker.io'
    }

    return url.trim().replace(/\/+$/, '')
  }
}
