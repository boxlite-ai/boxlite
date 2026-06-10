/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { OrganizationService } from './organization/services/organization.service'
import { UserService } from './user/user.service'
import { ApiKeyService } from './api-key/api-key.service'
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter'
import { SystemRole } from './user/enums/system-role.enum'
import { TypedConfigService } from './config/typed-config.service'
import { SchedulerRegistry } from '@nestjs/schedule'
import { RegionService } from './region/services/region.service'
import { RunnerService } from './box/services/runner.service'
import { RunnerAdapterFactory } from './box/runner-adapter/runnerAdapter'
import { RegionType } from './region/enums/region-type.enum'
import { RunnerState } from './box/enums/runner-state.enum'

export const BOXLITE_ADMIN_USER_ID = 'boxlite-admin'

@Injectable()
export class AppService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AppService.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly userService: UserService,
    private readonly organizationService: OrganizationService,
    private readonly apiKeyService: ApiKeyService,
    private readonly eventEmitterReadinessWatcher: EventEmitterReadinessWatcher,
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

    // Default runner init is not awaited because v2 runners depend on the API to be ready
    // TODO(image-rewrite): system template seeding removed with box_template; rebuild here.
    this.initializeDefaultRunner().catch((error) => {
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
        defaultOrganizationDefaultRegionId: this.configService.getOrThrow('defaultRegion.id'),
        role: SystemRole.ADMIN,
      })
    }

    const defaultOrg = await this.organizationService.findDefaultForUser(user.id)
    const { value } = await this.apiKeyService.ensureApiKeyValue(
      defaultOrg.id,
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

  private maskApiKeyForLog(value: string): string {
    if (value.length <= 8) {
      return '********'
    }
    return `${value.slice(0, 4)}...${value.slice(-4)}`
  }

}
