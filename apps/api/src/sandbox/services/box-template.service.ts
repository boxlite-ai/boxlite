/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, Not, In, Raw, ILike, IsNull, FindOptionsWhere, Like, LessThan } from 'typeorm'
import { v4 as uuidv4, validate as isUUID } from 'uuid'
import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { CreateBoxTemplateDto } from '../dto/create-box-template.dto'
import { BuildInfo } from '../entities/build-info.entity'
import { generateBuildInfoHash as generateBuildArtifactRef } from '../entities/build-info.entity'
import { Cron, CronExpression } from '@nestjs/schedule'
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter'
import { SandboxEvents } from '../constants/sandbox-events.constants'
import { SandboxCreatedEvent } from '../events/sandbox-create.event'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationService } from '../../organization/services/organization.service'
import { RunnerArtifactCache } from '../entities/runner-artifact-cache.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { OrganizationSuspendedTemplateDeactivatedEvent } from '../../organization/events/organization-suspended-template-deactivated.event'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'
import { PaginatedList } from '../../common/interfaces/paginated-list.interface'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxTemplateSortDirection, BoxTemplateSortField } from '../dto/list-box-templates-query.dto'
import { PER_SANDBOX_LIMIT_MESSAGE } from '../../common/constants/error-messages'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { Region } from '../../region/entities/region.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { RunnerEvents } from '../constants/runner-events'
import { RunnerDeletedEvent } from '../events/runner-deleted.event'
import { BoxTemplateRegion } from '../entities/box-template-region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxTemplateEvents } from '../constants/box-template-events'
import { BoxTemplateCreatedEvent } from '../events/box-template-created.event'
import { RunnerService } from './runner.service'
import { RegionService } from '../../region/services/region.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { BoxTemplateActivatedEvent } from '../events/box-template-activated.event'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { getSystemTemplateSortIndex, SYSTEM_TEMPLATES, SystemTemplateDefinition } from '../constants/system-templates'
import { isBoxLiteInternalArtifactRef } from '../utils/artifact-ref.util'

const IMAGE_NAME_REGEX = /^[a-zA-Z0-9_.\-:]+(\/[a-zA-Z0-9_.\-:]+)*(@sha256:[a-f0-9]{64})?$/
@Injectable()
export class BoxTemplateService {
  private readonly logger = new Logger(BoxTemplateService.name)

  constructor(
    private readonly sandboxRepository: SandboxRepository,
    @InjectRepository(BoxTemplate)
    private readonly boxTemplateRepository: Repository<BoxTemplate>,
    @InjectRepository(BuildInfo)
    private readonly buildInfoRepository: Repository<BuildInfo>,
    @InjectRepository(RunnerArtifactCache)
    private readonly runnerArtifactCacheRepository: Repository<RunnerArtifactCache>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    @InjectRepository(BoxTemplateRegion)
    private readonly boxTemplateRegionRepository: Repository<BoxTemplateRegion>,
    private readonly organizationService: OrganizationService,
    private readonly organizationUsageService: OrganizationUsageService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly runnerService: RunnerService,
    private readonly regionService: RegionService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: TypedConfigService,
  ) {}

  private validateImageName(name: string): string | null {
    // Check for digest format (@sha256:hash)
    if (name.includes('@sha256:')) {
      const [imageName, digest] = name.split('@sha256:')
      if (!imageName || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
        return 'Invalid digest format. Must be image@sha256:64_hex_characters'
      }
      return null
    }

    // Handle tag format (image:tag)
    if (!name.includes(':') || name.endsWith(':') || /:\s*$/.test(name)) {
      return 'Image name must include a tag (e.g., ubuntu:22.04) or digest (@sha256:...)'
    }

    if (name.endsWith(':latest')) {
      return 'Images with tag ":latest" are not allowed'
    }

    if (!IMAGE_NAME_REGEX.test(name)) {
      return 'Invalid image name format. Must be lowercase, may contain digits, dots, dashes, and single slashes between components'
    }

    return null
  }

  private validateBoxTemplateName(name: string): string | null {
    if (!IMAGE_NAME_REGEX.test(name)) {
      return 'Invalid template name format. May contain letters, digits, dots, colons, and dashes'
    }

    return null
  }

  private processEntrypoint(entrypoint?: string[]): string[] | undefined {
    if (!entrypoint || entrypoint.length === 0) {
      return undefined
    }

    // Filter out empty strings from the array
    const filteredEntrypoint = entrypoint.filter((cmd) => cmd && cmd.trim().length > 0)

    return filteredEntrypoint.length > 0 ? filteredEntrypoint : undefined
  }

  private async readyRunnerArtifactCacheExists(artifactRef: string, regionId: string): Promise<boolean> {
    return await this.runnerArtifactCacheRepository
      .createQueryBuilder('sr')
      .innerJoin('runner', 'r', 'r.id::text = sr."runnerId"::text')
      .where('sr."artifactRef" = :artifactRef', { artifactRef })
      .andWhere('sr.state = :runnerArtifactCacheState', { runnerArtifactCacheState: RunnerArtifactCacheState.READY })
      .andWhere('r.region = :regionId', { regionId })
      .andWhere('r.state = :runnerState', { runnerState: RunnerState.READY })
      .andWhere('r.unschedulable = false')
      .getExists()
  }

  async createFromPull(organization: Organization, createBoxTemplateDto: CreateBoxTemplateDto, general = false) {
    const regionId = await this.getValidatedOrDefaultRegionId(organization, createBoxTemplateDto.regionId)

    let pendingTemplateCountIncrement: number | undefined

    if (!createBoxTemplateDto.imageName) {
      throw new BadRequestException('Must specify an image name')
    }

    try {
      const entrypoint = createBoxTemplateDto.entrypoint
      const artifactRef: string | undefined = undefined
      const state: BoxTemplateState = BoxTemplateState.PENDING

      const nameValidationError = this.validateBoxTemplateName(createBoxTemplateDto.name)
      if (nameValidationError) {
        throw new BadRequestException(nameValidationError)
      }

      const imageValidationError = this.validateImageName(createBoxTemplateDto.imageName)
      if (imageValidationError) {
        throw new BadRequestException(imageValidationError)
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const newTemplateCount = 1

      const { pendingTemplateCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        newTemplateCount,
        createBoxTemplateDto.cpu,
        createBoxTemplateDto.memory,
        createBoxTemplateDto.disk,
      )

      if (pendingTemplateCountIncremented) {
        pendingTemplateCountIncrement = newTemplateCount
      }

      try {
        const templateId = uuidv4()

        const template = this.boxTemplateRepository.create({
          id: templateId,
          organizationId: organization.id,
          ...createBoxTemplateDto,
          entrypoint: this.processEntrypoint(entrypoint),
          mem: createBoxTemplateDto.memory, // Map memory to mem
          state,
          artifactRef,
          general,
          templateRegions: [{ templateId, regionId }],
        })

        const savedTemplate = await this.boxTemplateRepository.save(template)

        this.eventEmitter.emit(BoxTemplateEvents.CREATED, new BoxTemplateCreatedEvent(savedTemplate))

        return savedTemplate
      } catch (error) {
        if (error.code === '23505') {
          // PostgreSQL unique violation error code
          throw new ConflictException(
            `BoxTemplate with name "${createBoxTemplateDto.name}" already exists for this organization`,
          )
        }
        throw error
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingTemplateCountIncrement)
      throw error
    }
  }

  async ensureSystemTemplate(
    organization: Organization,
    templateDefinition: SystemTemplateDefinition,
  ): Promise<BoxTemplate> {
    const regionId = await this.getValidatedOrDefaultRegionId(organization)
    const existingTemplate = await this.boxTemplateRepository.findOne({
      where: { name: templateDefinition.name, general: true },
      relations: ['templateRegions'],
    })

    if (!existingTemplate) {
      return await this.createFromPull(
        organization,
        {
          name: templateDefinition.name,
          imageName: templateDefinition.imageName,
        },
        true,
      )
    }

    let shouldSaveTemplate = false
    const shouldReactivateSystemTemplate = [
      BoxTemplateState.INACTIVE,
      BoxTemplateState.ERROR,
      BoxTemplateState.BUILD_FAILED,
    ].includes(existingTemplate.state)
    const activeSystemTemplateMissingRef =
      existingTemplate.state === BoxTemplateState.ACTIVE && !existingTemplate.artifactRef?.trim()
    const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(regionId)
    const activeSystemTemplatePinnedToPreviousRegistry =
      existingTemplate.state === BoxTemplateState.ACTIVE &&
      this.isPinnedToDifferentInternalRegistry(existingTemplate.artifactRef, internalRegistry?.url)

    if (existingTemplate.imageName !== templateDefinition.imageName) {
      existingTemplate.imageName = templateDefinition.imageName
      shouldSaveTemplate = true
    }

    if (existingTemplate.hideFromUsers) {
      existingTemplate.hideFromUsers = false
      shouldSaveTemplate = true
    }

    if (
      shouldReactivateSystemTemplate ||
      activeSystemTemplateMissingRef ||
      activeSystemTemplatePinnedToPreviousRegistry
    ) {
      existingTemplate.state = BoxTemplateState.PENDING
      existingTemplate.errorReason = undefined
      shouldSaveTemplate = true

      if (activeSystemTemplatePinnedToPreviousRegistry) {
        existingTemplate.artifactRef = null
        existingTemplate.initialRunnerId = null
        existingTemplate.size = null
      }
    }

    const hasDefaultRegion = existingTemplate.templateRegions?.some(
      (templateRegion) => templateRegion.regionId === regionId,
    )

    if (!hasDefaultRegion) {
      await this.boxTemplateRegionRepository.save({
        templateId: existingTemplate.id,
        regionId,
      })
    }

    const savedTemplate = shouldSaveTemplate
      ? await this.boxTemplateRepository.save(existingTemplate)
      : existingTemplate

    if (
      shouldReactivateSystemTemplate ||
      activeSystemTemplateMissingRef ||
      activeSystemTemplatePinnedToPreviousRegistry
    ) {
      this.eventEmitter.emit(BoxTemplateEvents.ACTIVATED, new BoxTemplateActivatedEvent(savedTemplate))
    }

    return savedTemplate
  }

  private isPinnedToDifferentInternalRegistry(artifactRef?: string | null, internalRegistryUrl?: string | null) {
    if (!artifactRef || !internalRegistryUrl || !isBoxLiteInternalArtifactRef(artifactRef)) {
      return false
    }

    const currentRegistryPrefix = `${internalRegistryUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`
    return !artifactRef.startsWith(currentRegistryPrefix)
  }

  async createFromBuildInfo(organization: Organization, createBoxTemplateDto: CreateBoxTemplateDto, general = false) {
    const regionId = await this.getValidatedOrDefaultRegionId(organization, createBoxTemplateDto.regionId)

    let pendingTemplateCountIncrement: number | undefined
    let entrypoint: string[] | undefined = undefined

    try {
      const nameValidationError = this.validateBoxTemplateName(createBoxTemplateDto.name)
      if (nameValidationError) {
        throw new BadRequestException(nameValidationError)
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const newTemplateCount = 1

      const { pendingTemplateCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        newTemplateCount,
        createBoxTemplateDto.cpu,
        createBoxTemplateDto.memory,
        createBoxTemplateDto.disk,
      )

      if (pendingTemplateCountIncremented) {
        pendingTemplateCountIncrement = newTemplateCount
      }

      entrypoint = this.getEntrypointFromDockerfile(createBoxTemplateDto.buildInfo.dockerfileContent)

      const templateId = uuidv4()

      const template = this.boxTemplateRepository.create({
        id: templateId,
        organizationId: organization.id,
        ...createBoxTemplateDto,
        entrypoint: this.processEntrypoint(entrypoint),
        mem: createBoxTemplateDto.memory, // Map memory to mem
        state: BoxTemplateState.PENDING,
        general,
        templateRegions: [{ templateId, regionId }],
      })

      const buildArtifactRef = generateBuildArtifactRef(
        createBoxTemplateDto.buildInfo.dockerfileContent,
        createBoxTemplateDto.buildInfo.contextHashes,
      )

      // Check if buildInfo with the same artifactRef already exists
      const existingBuildInfo = await this.buildInfoRepository.findOne({
        where: { artifactRef: buildArtifactRef },
      })

      if (existingBuildInfo) {
        template.buildInfo = existingBuildInfo
        // Update lastUsed once per minute at most
        if (await this.redisLockProvider.lock(`build-info:${existingBuildInfo.artifactRef}:update`, 60)) {
          existingBuildInfo.lastUsedAt = new Date()
          await this.buildInfoRepository.save(existingBuildInfo)
        }
      } else {
        const buildInfoEntity = this.buildInfoRepository.create({
          ...createBoxTemplateDto.buildInfo,
        })
        await this.buildInfoRepository.save(buildInfoEntity)
        template.buildInfo = buildInfoEntity
      }

      const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(regionId)
      if (!internalRegistry) {
        throw new Error('No internal registry found for template')
      }
      template.artifactRef = `${internalRegistry.url.replace(/^(https?:\/\/)/, '')}/${internalRegistry.project || 'boxlite'}/${buildArtifactRef}`

      const exists = await this.readyRunnerArtifactCacheExists(template.artifactRef, regionId)

      if (exists) {
        const existingTemplate = await this.boxTemplateRepository.findOne({
          where: { artifactRef: template.artifactRef, size: Not(IsNull()) },
          select: ['id', 'size'],
        })

        if (existingTemplate?.size != null) {
          if (existingTemplate.size > organization.maxTemplateSize) {
            throw new BadRequestException(
              `BoxTemplate size (${existingTemplate.size.toFixed(2)}GB) exceeds maximum allowed size of ${organization.maxTemplateSize}GB`,
            )
          }
          template.size = existingTemplate.size
          template.state = BoxTemplateState.ACTIVE
          template.lastUsedAt = new Date()
        }
      }

      try {
        const savedTemplate = await this.boxTemplateRepository.save(template)

        this.eventEmitter.emit(BoxTemplateEvents.CREATED, new BoxTemplateCreatedEvent(savedTemplate))

        return savedTemplate
      } catch (error) {
        if (error.code === '23505') {
          // PostgreSQL unique violation error code
          throw new ConflictException(
            `BoxTemplate with name "${createBoxTemplateDto.name}" already exists for this organization`,
          )
        }
        throw error
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingTemplateCountIncrement)
      throw error
    }
  }

  async removeBoxTemplate(templateId: string) {
    const template = await this.boxTemplateRepository.findOne({
      where: { id: templateId },
    })

    if (!template) {
      throw new NotFoundException(`BoxTemplate ${templateId} not found`)
    }
    if (template.general) {
      throw new ForbiddenException('You cannot delete a general template')
    }
    template.state = BoxTemplateState.REMOVING
    await this.boxTemplateRepository.save(template)
  }

  async getAllBoxTemplates(
    organizationId: string,
    page = 1,
    limit = 10,
    filters?: { name?: string },
    sort?: { field?: BoxTemplateSortField; direction?: BoxTemplateSortDirection },
  ): Promise<PaginatedList<BoxTemplate>> {
    const pageNum = Number(page)
    const limitNum = Number(limit)

    const { name } = filters || {}
    const { field: sortField, direction: sortDirection } = sort || {}

    const baseFindOptions: FindOptionsWhere<BoxTemplate> = {
      ...(name ? { name: ILike(`%${name}%`) } : {}),
    }

    // Retrieve all templates belonging to the organization as well as all general templates
    const where: FindOptionsWhere<BoxTemplate>[] = [
      {
        ...baseFindOptions,
        organizationId,
      },
      {
        ...baseFindOptions,
        general: true,
        hideFromUsers: false,
      },
    ]

    const [items, total] = await this.boxTemplateRepository.findAndCount({
      where,
      relations: ['templateRegions'],
      order: {
        general: 'ASC', // Sort general templates last
        [sortField]: {
          direction: sortDirection,
          nulls: 'LAST',
        },
        ...(sortField !== BoxTemplateSortField.CREATED_AT && { createdAt: 'DESC' }),
      },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    })

    // Filter out template regions that are not available to the organization
    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))

    for (const template of items) {
      if (template.templateRegions) {
        template.templateRegions = template.templateRegions.filter((sr) => availableRegionIds.has(sr.regionId))
      }
    }

    return {
      items,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limit),
    }
  }

  async getSystemTemplates(organizationId: string): Promise<BoxTemplate[]> {
    const templates = await this.boxTemplateRepository.find({
      where: {
        general: true,
        hideFromUsers: false,
        state: BoxTemplateState.ACTIVE,
      },
      relations: ['templateRegions'],
      order: {
        name: 'ASC',
      },
    })

    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))
    const defaultTemplate = this.configService.get('defaultTemplate')
    const systemTemplateNames = new Set(SYSTEM_TEMPLATES.map((template) => template.name))

    const availableTemplates = templates
      .filter((template) => systemTemplateNames.has(template.name))
      .filter((template) => Boolean(template.artifactRef?.trim()))
      .map((template) => {
        template.templateRegions = template.templateRegions?.filter((sr) => availableRegionIds.has(sr.regionId)) ?? []
        return template
      })
      .filter((template) => template.templateRegions.length > 0)

    return availableTemplates.sort((a, b) => {
      if (defaultTemplate) {
        if (a.name === defaultTemplate || a.id === defaultTemplate) return -1
        if (b.name === defaultTemplate || b.id === defaultTemplate) return 1
      }

      const aLabel = a.imageName || a.name
      const bLabel = b.imageName || b.name
      const order = getSystemTemplateSortIndex(aLabel) - getSystemTemplateSortIndex(bLabel)
      if (order !== 0) return order

      return aLabel.localeCompare(bLabel)
    })
  }

  async getBoxTemplate(templateId: string): Promise<BoxTemplate> {
    const template = await this.boxTemplateRepository.findOne({
      where: { id: templateId },
    })

    if (!template) {
      throw new NotFoundException(`BoxTemplate ${templateId} not found`)
    }

    return template
  }

  async getBoxTemplateWithRegions(templateIdOrName: string, organizationId: string): Promise<BoxTemplate> {
    const where: FindOptionsWhere<BoxTemplate>[] = [
      { name: templateIdOrName, organizationId },
      { name: templateIdOrName, general: true },
    ]
    if (isUUID(templateIdOrName)) {
      where.push({ id: templateIdOrName })
    }

    const template = await this.boxTemplateRepository.findOne({
      where,
      relations: ['templateRegions'],
      order: { general: 'ASC' },
    })

    if (!template) {
      throw new NotFoundException(`BoxTemplate ${templateIdOrName} not found`)
    }

    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))
    if (template.templateRegions) {
      template.templateRegions = template.templateRegions.filter((sr) => availableRegionIds.has(sr.regionId))
    }

    return template
  }

  async getBoxTemplateByName(templateName: string, organizationId: string): Promise<BoxTemplate> {
    const template = await this.boxTemplateRepository.findOne({
      where: { name: templateName, organizationId },
    })

    if (!template) {
      //  check if the template is general
      const generalTemplate = await this.boxTemplateRepository.findOne({
        where: { name: templateName, general: true },
      })
      if (generalTemplate) {
        return generalTemplate
      }

      throw new NotFoundException(`BoxTemplate with name ${templateName} not found`)
    }

    return template
  }

  async setBoxTemplateGeneralStatus(templateId: string, general: boolean) {
    const template = await this.boxTemplateRepository.findOne({
      where: { id: templateId },
    })

    if (!template) {
      throw new NotFoundException(`BoxTemplate ${templateId} not found`)
    }

    template.general = general
    return await this.boxTemplateRepository.save(template)
  }

  async getBuildLogsUrl(template: BoxTemplate): Promise<string> {
    if (!template.initialRunnerId) {
      throw new NotFoundException(`BoxTemplate ${template.id} has no initial runner`)
    }

    const runner = await this.runnerService.findOneOrFail(template.initialRunnerId)
    const region = await this.regionService.findOne(runner.region, true)

    if (!region) {
      throw new NotFoundException(`Region for initial runner for template ${template.id} not found`)
    }

    if (!region.proxyUrl) {
      return `${this.configService.getOrThrow('proxy.protocol')}://${this.configService.getOrThrow('proxy.domain')}/templates/${template.id}/build-logs`
    }

    return region.proxyUrl + '/templates/' + template.id + '/build-logs'
  }

  private async validateOrganizationQuotas(
    organization: Organization,
    addedTemplateCount: number,
    cpu?: number,
    memory?: number,
    disk?: number,
  ): Promise<{
    pendingTemplateCountIncremented: boolean
  }> {
    // validate per-sandbox quotas
    if (cpu && cpu > organization.maxCpuPerSandbox) {
      throw new ForbiddenException(
        `CPU request ${cpu} exceeds maximum allowed per sandbox (${organization.maxCpuPerSandbox}).\n${PER_SANDBOX_LIMIT_MESSAGE}`,
      )
    }
    if (memory && memory > organization.maxMemoryPerSandbox) {
      throw new ForbiddenException(
        `Memory request ${memory}GB exceeds maximum allowed per sandbox (${organization.maxMemoryPerSandbox}GB).\n${PER_SANDBOX_LIMIT_MESSAGE}`,
      )
    }
    if (disk && disk > organization.maxDiskPerSandbox) {
      throw new ForbiddenException(
        `Disk request ${disk}GB exceeds maximum allowed per sandbox (${organization.maxDiskPerSandbox}GB).\n${PER_SANDBOX_LIMIT_MESSAGE}`,
      )
    }

    // validate usage quotas
    await this.organizationUsageService.incrementPendingTemplateUsage(organization.id, addedTemplateCount)

    const usageOverview = await this.organizationUsageService.getTemplateUsageOverview(organization.id)

    try {
      if (usageOverview.currentTemplateUsage + usageOverview.pendingTemplateUsage > organization.templateQuota) {
        throw new ForbiddenException(`BoxTemplate quota exceeded. Maximum allowed: ${organization.templateQuota}`)
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, addedTemplateCount)
      throw error
    }

    return {
      pendingTemplateCountIncremented: true,
    }
  }

  async rollbackPendingUsage(organizationId: string, pendingTemplateCountIncrement?: number): Promise<void> {
    if (!pendingTemplateCountIncrement) {
      return
    }

    try {
      await this.organizationUsageService.decrementPendingTemplateUsage(organizationId, pendingTemplateCountIncrement)
    } catch (error) {
      this.logger.error(`Error rolling back pending template usage: ${error}`)
    }
  }

  @OnEvent(SandboxEvents.CREATED)
  private async handleSandboxCreatedEvent(event: SandboxCreatedEvent) {
    if (!event.sandbox.template) {
      return
    }

    // Update once per minute at most
    if (!(await this.redisLockProvider.lock(`template:${event.sandbox.template}:update-last-used`, 60))) {
      return
    }

    const template = await this.getBoxTemplateByName(event.sandbox.template, event.sandbox.organizationId)
    template.lastUsedAt = event.sandbox.createdAt
    await this.boxTemplateRepository.save(template)
  }

  async activateBoxTemplate(templateId: string, organization: Organization): Promise<BoxTemplate> {
    const lockKey = `template:${templateId}:activate`
    await this.redisLockProvider.waitForLock(lockKey, 60)

    let pendingTemplateCountIncrement: number | undefined

    try {
      const template = await this.boxTemplateRepository.findOne({
        where: { id: templateId },
      })

      if (!template) {
        throw new NotFoundException(`BoxTemplate ${templateId} not found`)
      }

      if (template.state === BoxTemplateState.ACTIVE) {
        throw new BadRequestException(`BoxTemplate ${templateId} is already active`)
      }

      if (template.state !== BoxTemplateState.INACTIVE) {
        throw new BadRequestException(
          `BoxTemplate ${templateId} cannot be activated - it is in ${template.state} state`,
        )
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const activatedTemplateCount = 1

      const { pendingTemplateCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        activatedTemplateCount,
        template.cpu,
        template.mem,
        template.disk,
      )

      if (pendingTemplateCountIncremented) {
        pendingTemplateCountIncrement = activatedTemplateCount
      }

      template.state = BoxTemplateState.PENDING
      const savedTemplate = await this.boxTemplateRepository.save(template)

      this.eventEmitter.emit(BoxTemplateEvents.ACTIVATED, new BoxTemplateActivatedEvent(savedTemplate))

      return savedTemplate
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingTemplateCountIncrement)
      throw error
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  async canCleanupImage(imageName: string): Promise<boolean> {
    const template = await this.boxTemplateRepository.findOne({
      where: {
        state: Not(In([BoxTemplateState.ERROR, BoxTemplateState.BUILD_FAILED])),
        artifactRef: imageName,
      },
    })

    if (template) {
      return false
    }

    const sandbox = await this.sandboxRepository.findOne({
      where: [
        {
          existingBackupSnapshots: Raw((alias) => `${alias} @> '[{"templateName":"${imageName}"}]'::jsonb`),
        },
        {
          existingBackupSnapshots: Raw((alias) => `${alias} @> '[{"imageName":"${imageName}"}]'::jsonb`),
        },
        {
          backupSnapshot: imageName,
        },
      ],
    })

    if (sandbox && sandbox.state !== SandboxState.DESTROYED) {
      return false
    }

    return true
  }

  async deactivateBoxTemplate(templateId: string): Promise<void> {
    const template = await this.boxTemplateRepository.findOne({
      where: { id: templateId },
    })

    if (!template) {
      throw new NotFoundException(`BoxTemplate ${templateId} not found`)
    }

    if (template.state === BoxTemplateState.INACTIVE) {
      return
    }

    template.state = BoxTemplateState.INACTIVE
    await this.boxTemplateRepository.save(template)

    try {
      const countActiveTemplates = await this.boxTemplateRepository.count({
        where: {
          state: BoxTemplateState.ACTIVE,
          artifactRef: template.artifactRef,
        },
      })

      if (countActiveTemplates === 0) {
        // Set associated RunnerArtifactCache records to REMOVING state
        const result = await this.runnerArtifactCacheRepository.update(
          { artifactRef: template.artifactRef },
          { state: RunnerArtifactCacheState.REMOVING },
        )
        this.logger.debug(
          `Deactivated template ${template.id} and marked ${result.affected} RunnerArtifactCaches for removal`,
        )
      }
    } catch (error) {
      this.logger.error(
        `Deactivated template ${template.id}, but failed to mark runner artifact caches for removal`,
        error,
      )
    }
  }

  // TODO: revise/cleanup
  getEntrypointFromDockerfile(dockerfileContent: string): string[] {
    // Match ENTRYPOINT with either a string or JSON array
    const matches = [...dockerfileContent.matchAll(/ENTRYPOINT\s+(.*)/g)]
    const entrypointMatch = matches.length ? matches[matches.length - 1] : null
    if (entrypointMatch) {
      const rawEntrypoint = entrypointMatch[1].trim()
      try {
        // Try parsing as JSON array
        const parsed = JSON.parse(rawEntrypoint)
        if (Array.isArray(parsed)) {
          return parsed
        }
      } catch {
        // Fallback: it's probably a plain string
        return [rawEntrypoint.replace(/["']/g, '')]
      }
    }

    return ['sleep', 'infinity']
  }

  /**
   * Validates and returns a region ID for template availability.
   *
   * @param organization - The organization which is creating the template.
   * @param regionId - The requested region ID. If omitted, the organization's default region is used.
   * @returns The validated region ID
   * @throws {NotFoundException} If the requested region is not available to the organization
   */
  private async getValidatedOrDefaultRegionId(organization: Organization, regionId?: string): Promise<string> {
    if (!regionId) {
      return organization.defaultRegionId || this.configService.getOrThrow('defaultRegion.id')
    }

    const region = await this.regionRepository.findOne({
      where: { id: regionId },
    })

    if (!region) {
      throw new NotFoundException('Region not found')
    }

    const availableRegions = await this.organizationService.listAvailableRegions(organization.id)

    if (!availableRegions.some((r) => r.id === regionId)) {
      if (region.regionType === RegionType.SHARED) {
        // region is public, but the organization does not have a quota for it
        throw new ForbiddenException(`Region ${regionId} is not available to the organization`)
      } else {
        // region is not public, respond as if the region was not found
        throw new NotFoundException('Region not found')
      }
    }

    return regionId
  }

  /**
   * @param templateId
   * @returns The regions where the template is configured to be propagated to.
   */
  async getBoxTemplateRegions(templateId: string): Promise<Region[]> {
    return await this.regionRepository
      .createQueryBuilder('r')
      .innerJoin('box_template_region', 'sr', 'sr."regionId" = r.id')
      .where('sr."templateId" = :templateId', { templateId })
      .getMany()
  }

  /**
   * @param templateId - The ID of the template.
   * @param regionId - The ID of the region.
   * @returns true if the template is available in the region, false otherwise.
   */
  async isAvailableInRegion(templateId: string, regionId: string): Promise<boolean> {
    return await this.boxTemplateRegionRepository.exists({
      where: {
        templateId,
        regionId,
      },
    })
  }

  @OnEvent(OrganizationEvents.SUSPENDED_TEMPLATE_DEACTIVATED)
  async handleSuspendedOrganizationTemplateDeactivated(event: OrganizationSuspendedTemplateDeactivatedEvent) {
    await this.deactivateBoxTemplate(event.templateId).catch((error) => {
      //  log the error for now, but don't throw it as it will be retried
      this.logger.error(
        `Error deactivating template from suspended organization. TemplateId: ${event.templateId}: `,
        error,
      )
    })
  }

  @OnAsyncEvent({
    event: RunnerEvents.DELETED,
  })
  async handleRunnerDeletedEvent(payload: RunnerDeletedEvent): Promise<void> {
    await payload.entityManager.update(
      RunnerArtifactCache,
      { runnerId: payload.runnerId },
      { state: RunnerArtifactCacheState.REMOVING },
    )
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'cleanup-failed-runner-artifact-caches' })
  @LogExecution('cleanup-failed-runner-artifact-caches')
  @WithInstrumentation()
  async cleanupFailedRunnerArtifactCaches() {
    const retentionHours = this.configService.getOrThrow('failedRunnerArtifactCacheRetentionHours')
    const cutoff = new Date()
    cutoff.setHours(cutoff.getHours() - retentionHours)

    const result = await this.runnerArtifactCacheRepository.delete({
      artifactRef: Like('boxlite-%'),
      state: RunnerArtifactCacheState.ERROR,
      updatedAt: LessThan(cutoff),
    })

    if (result.affected > 0) {
      this.logger.debug(`Cleaned up ${result.affected} failed runner artifact caches`)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'cleanup-decommissioned-runner-artifact-caches' })
  @LogExecution('cleanup-decommissioned-runner-artifact-caches')
  @WithInstrumentation()
  async cleanupDecommissionedRunnerArtifactCaches() {
    const cutoff = new Date()
    cutoff.setHours(cutoff.getHours() - 1)

    const runnerArtifactCaches = await this.runnerArtifactCacheRepository
      .createQueryBuilder('sr')
      .innerJoin('runner', 'r', 'r.id::text = sr."runnerId"::text')
      .where('r.state = :runnerState', { runnerState: RunnerState.DECOMMISSIONED })
      .andWhere('sr."updatedAt" < :cutoff', { cutoff })
      .select('sr.id')
      .take(500)
      .getMany()

    if (runnerArtifactCaches.length === 0) {
      return
    }

    const ids = runnerArtifactCaches.map((sr) => sr.id)
    await this.runnerArtifactCacheRepository.delete(ids)

    this.logger.debug(`Cleaned up ${ids.length} runner artifact caches from decommissioned runners`)
  }
}
