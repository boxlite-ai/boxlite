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
import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { CreateSavedImageDto } from '../dto/create-saved-image.dto'
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
import { OrganizationSuspendedSavedImageDeactivatedEvent } from '../../organization/events/organization-suspended-saved-image-deactivated.event'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'
import { PaginatedList } from '../../common/interfaces/paginated-list.interface'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { SavedImageSortDirection, SavedImageSortField } from '../dto/list-saved-images-query.dto'
import { PER_SANDBOX_LIMIT_MESSAGE } from '../../common/constants/error-messages'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { Region } from '../../region/entities/region.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { RunnerEvents } from '../constants/runner-events'
import { RunnerDeletedEvent } from '../events/runner-deleted.event'
import { SavedImageRegion } from '../entities/saved-image-region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { SavedImageEvents } from '../constants/saved-image-events'
import { SavedImageCreatedEvent } from '../events/saved-image-created.event'
import { RunnerService } from './runner.service'
import { RegionService } from '../../region/services/region.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { SavedImageActivatedEvent } from '../events/saved-image-activated.event'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { getSystemSavedImageSortIndex, SYSTEM_SAVED_IMAGES, SystemSavedImageDefinition } from '../constants/system-saved-images'
import { isBoxLiteInternalArtifactRef } from '../utils/artifact-ref.util'

const IMAGE_NAME_REGEX = /^[a-zA-Z0-9_.\-:]+(\/[a-zA-Z0-9_.\-:]+)*(@sha256:[a-f0-9]{64})?$/
@Injectable()
export class SavedImageService {
  private readonly logger = new Logger(SavedImageService.name)

  constructor(
    private readonly sandboxRepository: SandboxRepository,
    @InjectRepository(SavedImage)
    private readonly savedImageRepository: Repository<SavedImage>,
    @InjectRepository(BuildInfo)
    private readonly buildInfoRepository: Repository<BuildInfo>,
    @InjectRepository(RunnerArtifactCache)
    private readonly runnerArtifactCacheRepository: Repository<RunnerArtifactCache>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    @InjectRepository(SavedImageRegion)
    private readonly savedImageRegionRepository: Repository<SavedImageRegion>,
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

  private validateSavedImageName(name: string): string | null {
    if (!IMAGE_NAME_REGEX.test(name)) {
      return 'Invalid saved image name format. May contain letters, digits, dots, colons, and dashes'
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

  async createFromPull(organization: Organization, createSavedImageDto: CreateSavedImageDto, general = false) {
    const regionId = await this.getValidatedOrDefaultRegionId(organization, createSavedImageDto.regionId)

    let pendingSavedImageCountIncrement: number | undefined

    if (!createSavedImageDto.imageName) {
      throw new BadRequestException('Must specify an image name')
    }

    try {
      const entrypoint = createSavedImageDto.entrypoint
      const artifactRef: string | undefined = undefined
      const state: SavedImageState = SavedImageState.PENDING

      const nameValidationError = this.validateSavedImageName(createSavedImageDto.name)
      if (nameValidationError) {
        throw new BadRequestException(nameValidationError)
      }

      const imageValidationError = this.validateImageName(createSavedImageDto.imageName)
      if (imageValidationError) {
        throw new BadRequestException(imageValidationError)
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const newSavedImageCount = 1

      const { pendingSavedImageCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        newSavedImageCount,
        createSavedImageDto.cpu,
        createSavedImageDto.memory,
        createSavedImageDto.disk,
      )

      if (pendingSavedImageCountIncremented) {
        pendingSavedImageCountIncrement = newSavedImageCount
      }

      try {
        const savedImageId = uuidv4()

        const savedImage = this.savedImageRepository.create({
          id: savedImageId,
          organizationId: organization.id,
          ...createSavedImageDto,
          entrypoint: this.processEntrypoint(entrypoint),
          mem: createSavedImageDto.memory, // Map memory to mem
          state,
          artifactRef,
          general,
          savedImageRegions: [{ savedImageId, regionId }],
        })

        const savedSavedImage = await this.savedImageRepository.save(savedImage)

        this.eventEmitter.emit(SavedImageEvents.CREATED, new SavedImageCreatedEvent(savedSavedImage))

        return savedSavedImage
      } catch (error) {
        if (error.code === '23505') {
          // PostgreSQL unique violation error code
          throw new ConflictException(
            `Saved image with name "${createSavedImageDto.name}" already exists for this organization`,
          )
        }
        throw error
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingSavedImageCountIncrement)
      throw error
    }
  }

  async ensureSystemSavedImage(
    organization: Organization,
    savedImageDefinition: SystemSavedImageDefinition,
  ): Promise<SavedImage> {
    const regionId = await this.getValidatedOrDefaultRegionId(organization)
    const existingSavedImage = await this.savedImageRepository.findOne({
      where: { name: savedImageDefinition.name, general: true },
      relations: ['savedImageRegions'],
    })

    if (!existingSavedImage) {
      return await this.createFromPull(
        organization,
        {
          name: savedImageDefinition.name,
          imageName: savedImageDefinition.imageName,
        },
        true,
      )
    }

    let shouldSaveSavedImage = false
    const shouldReactivateSystemSavedImage = [
      SavedImageState.INACTIVE,
      SavedImageState.ERROR,
      SavedImageState.BUILD_FAILED,
    ].includes(existingSavedImage.state)
    const activeSystemSavedImageMissingRef =
      existingSavedImage.state === SavedImageState.ACTIVE && !existingSavedImage.artifactRef?.trim()
    const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(regionId)
    const activeSystemSavedImagePinnedToPreviousRegistry =
      existingSavedImage.state === SavedImageState.ACTIVE &&
      this.isPinnedToDifferentInternalRegistry(existingSavedImage.artifactRef, internalRegistry?.url)

    if (existingSavedImage.imageName !== savedImageDefinition.imageName) {
      existingSavedImage.imageName = savedImageDefinition.imageName
      shouldSaveSavedImage = true
    }

    if (existingSavedImage.hideFromUsers) {
      existingSavedImage.hideFromUsers = false
      shouldSaveSavedImage = true
    }

    if (
      shouldReactivateSystemSavedImage ||
      activeSystemSavedImageMissingRef ||
      activeSystemSavedImagePinnedToPreviousRegistry
    ) {
      existingSavedImage.state = SavedImageState.PENDING
      existingSavedImage.errorReason = undefined
      shouldSaveSavedImage = true

      if (activeSystemSavedImagePinnedToPreviousRegistry) {
        existingSavedImage.artifactRef = null
        existingSavedImage.initialRunnerId = null
        existingSavedImage.size = null
      }
    }

    const hasDefaultRegion = existingSavedImage.savedImageRegions?.some(
      (savedImageRegion) => savedImageRegion.regionId === regionId,
    )

    if (!hasDefaultRegion) {
      await this.savedImageRegionRepository.save({
        savedImageId: existingSavedImage.id,
        regionId,
      })
    }

    const savedSavedImage = shouldSaveSavedImage
      ? await this.savedImageRepository.save(existingSavedImage)
      : existingSavedImage

    if (
      shouldReactivateSystemSavedImage ||
      activeSystemSavedImageMissingRef ||
      activeSystemSavedImagePinnedToPreviousRegistry
    ) {
      this.eventEmitter.emit(SavedImageEvents.ACTIVATED, new SavedImageActivatedEvent(savedSavedImage))
    }

    return savedSavedImage
  }

  private isPinnedToDifferentInternalRegistry(artifactRef?: string | null, internalRegistryUrl?: string | null) {
    if (!artifactRef || !internalRegistryUrl || !isBoxLiteInternalArtifactRef(artifactRef)) {
      return false
    }

    const currentRegistryPrefix = `${internalRegistryUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/`
    return !artifactRef.startsWith(currentRegistryPrefix)
  }

  async createFromBuildInfo(organization: Organization, createSavedImageDto: CreateSavedImageDto, general = false) {
    const regionId = await this.getValidatedOrDefaultRegionId(organization, createSavedImageDto.regionId)

    let pendingSavedImageCountIncrement: number | undefined
    let entrypoint: string[] | undefined = undefined

    try {
      const nameValidationError = this.validateSavedImageName(createSavedImageDto.name)
      if (nameValidationError) {
        throw new BadRequestException(nameValidationError)
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const newSavedImageCount = 1

      const { pendingSavedImageCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        newSavedImageCount,
        createSavedImageDto.cpu,
        createSavedImageDto.memory,
        createSavedImageDto.disk,
      )

      if (pendingSavedImageCountIncremented) {
        pendingSavedImageCountIncrement = newSavedImageCount
      }

      entrypoint = this.getEntrypointFromDockerfile(createSavedImageDto.buildInfo.dockerfileContent)

      const savedImageId = uuidv4()

      const savedImage = this.savedImageRepository.create({
        id: savedImageId,
        organizationId: organization.id,
        ...createSavedImageDto,
        entrypoint: this.processEntrypoint(entrypoint),
        mem: createSavedImageDto.memory, // Map memory to mem
        state: SavedImageState.PENDING,
        general,
        savedImageRegions: [{ savedImageId, regionId }],
      })

      const buildArtifactRef = generateBuildArtifactRef(
        createSavedImageDto.buildInfo.dockerfileContent,
        createSavedImageDto.buildInfo.contextHashes,
      )

      // Check if buildInfo with the same artifactRef already exists
      const existingBuildInfo = await this.buildInfoRepository.findOne({
        where: { artifactRef: buildArtifactRef },
      })

      if (existingBuildInfo) {
        savedImage.buildInfo = existingBuildInfo
        // Update lastUsed once per minute at most
        if (await this.redisLockProvider.lock(`build-info:${existingBuildInfo.artifactRef}:update`, 60)) {
          existingBuildInfo.lastUsedAt = new Date()
          await this.buildInfoRepository.save(existingBuildInfo)
        }
      } else {
        const buildInfoEntity = this.buildInfoRepository.create({
          ...createSavedImageDto.buildInfo,
        })
        await this.buildInfoRepository.save(buildInfoEntity)
        savedImage.buildInfo = buildInfoEntity
      }

      const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(regionId)
      if (!internalRegistry) {
        throw new Error('No internal registry found for savedImage')
      }
      savedImage.artifactRef = `${internalRegistry.url.replace(/^(https?:\/\/)/, '')}/${internalRegistry.project || 'boxlite'}/${buildArtifactRef}`

      const exists = await this.readyRunnerArtifactCacheExists(savedImage.artifactRef, regionId)

      if (exists) {
        const existingSavedImage = await this.savedImageRepository.findOne({
          where: { artifactRef: savedImage.artifactRef, size: Not(IsNull()) },
          select: ['id', 'size'],
        })

        if (existingSavedImage?.size != null) {
          if (existingSavedImage.size > organization.maxSavedImageSize) {
            throw new BadRequestException(
              `SavedImage size (${existingSavedImage.size.toFixed(2)}GB) exceeds maximum allowed size of ${organization.maxSavedImageSize}GB`,
            )
          }
          savedImage.size = existingSavedImage.size
          savedImage.state = SavedImageState.ACTIVE
          savedImage.lastUsedAt = new Date()
        }
      }

      try {
        const savedSavedImage = await this.savedImageRepository.save(savedImage)

        this.eventEmitter.emit(SavedImageEvents.CREATED, new SavedImageCreatedEvent(savedSavedImage))

        return savedSavedImage
      } catch (error) {
        if (error.code === '23505') {
          // PostgreSQL unique violation error code
          throw new ConflictException(
            `Saved image with name "${createSavedImageDto.name}" already exists for this organization`,
          )
        }
        throw error
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingSavedImageCountIncrement)
      throw error
    }
  }

  async removeSavedImage(savedImageId: string) {
    const savedImage = await this.savedImageRepository.findOne({
      where: { id: savedImageId },
    })

    if (!savedImage) {
      throw new NotFoundException(`SavedImage ${savedImageId} not found`)
    }
    if (savedImage.general) {
      throw new ForbiddenException('You cannot delete a general savedImage')
    }
    savedImage.state = SavedImageState.REMOVING
    await this.savedImageRepository.save(savedImage)
  }

  async getAllSavedImages(
    organizationId: string,
    page = 1,
    limit = 10,
    filters?: { name?: string },
    sort?: { field?: SavedImageSortField; direction?: SavedImageSortDirection },
  ): Promise<PaginatedList<SavedImage>> {
    const pageNum = Number(page)
    const limitNum = Number(limit)

    const { name } = filters || {}
    const { field: sortField, direction: sortDirection } = sort || {}

    const baseFindOptions: FindOptionsWhere<SavedImage> = {
      ...(name ? { name: ILike(`%${name}%`) } : {}),
    }

    // Retrieve all savedImages belonging to the organization as well as all general savedImages
    const where: FindOptionsWhere<SavedImage>[] = [
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

    const [items, total] = await this.savedImageRepository.findAndCount({
      where,
      relations: ['savedImageRegions'],
      order: {
        general: 'ASC', // Sort general savedImages last
        [sortField]: {
          direction: sortDirection,
          nulls: 'LAST',
        },
        ...(sortField !== SavedImageSortField.CREATED_AT && { createdAt: 'DESC' }),
      },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    })

    // Filter out savedImage regions that are not available to the organization
    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))

    for (const savedImage of items) {
      if (savedImage.savedImageRegions) {
        savedImage.savedImageRegions = savedImage.savedImageRegions.filter((sr) => availableRegionIds.has(sr.regionId))
      }
    }

    return {
      items,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limit),
    }
  }

  async getSystemSavedImages(organizationId: string): Promise<SavedImage[]> {
    const savedImages = await this.savedImageRepository.find({
      where: {
        general: true,
        hideFromUsers: false,
        state: SavedImageState.ACTIVE,
      },
      relations: ['savedImageRegions'],
      order: {
        name: 'ASC',
      },
    })

    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))
    const defaultSavedImage = this.configService.get('defaultSavedImage')
    const systemSavedImageNames = new Set(SYSTEM_SAVED_IMAGES.map((savedImage) => savedImage.name))

    const availableSavedImages = savedImages
      .filter((savedImage) => systemSavedImageNames.has(savedImage.name))
      .filter((savedImage) => Boolean(savedImage.artifactRef?.trim()))
      .map((savedImage) => {
        savedImage.savedImageRegions = savedImage.savedImageRegions?.filter((sr) => availableRegionIds.has(sr.regionId)) ?? []
        return savedImage
      })
      .filter((savedImage) => savedImage.savedImageRegions.length > 0)

    return availableSavedImages.sort((a, b) => {
      if (defaultSavedImage) {
        if (a.name === defaultSavedImage || a.id === defaultSavedImage) return -1
        if (b.name === defaultSavedImage || b.id === defaultSavedImage) return 1
      }

      const aLabel = a.imageName || a.name
      const bLabel = b.imageName || b.name
      const order = getSystemSavedImageSortIndex(aLabel) - getSystemSavedImageSortIndex(bLabel)
      if (order !== 0) return order

      return aLabel.localeCompare(bLabel)
    })
  }

  async getSavedImage(savedImageId: string): Promise<SavedImage> {
    const savedImage = await this.savedImageRepository.findOne({
      where: { id: savedImageId },
    })

    if (!savedImage) {
      throw new NotFoundException(`SavedImage ${savedImageId} not found`)
    }

    return savedImage
  }

  async getSavedImageWithRegions(savedImageIdOrName: string, organizationId: string): Promise<SavedImage> {
    const where: FindOptionsWhere<SavedImage>[] = [
      { name: savedImageIdOrName, organizationId },
      { name: savedImageIdOrName, general: true },
    ]
    if (isUUID(savedImageIdOrName)) {
      where.push({ id: savedImageIdOrName })
    }

    const savedImage = await this.savedImageRepository.findOne({
      where,
      relations: ['savedImageRegions'],
      order: { general: 'ASC' },
    })

    if (!savedImage) {
      throw new NotFoundException(`SavedImage ${savedImageIdOrName} not found`)
    }

    const availableRegions = await this.organizationService.listAvailableRegions(organizationId)
    const availableRegionIds = new Set(availableRegions.map((r) => r.id))
    if (savedImage.savedImageRegions) {
      savedImage.savedImageRegions = savedImage.savedImageRegions.filter((sr) => availableRegionIds.has(sr.regionId))
    }

    return savedImage
  }

  async getSavedImageByName(savedImageName: string, organizationId: string): Promise<SavedImage> {
    const savedImage = await this.savedImageRepository.findOne({
      where: { name: savedImageName, organizationId },
    })

    if (!savedImage) {
      //  check if the saved image is general
      const generalSavedImage = await this.savedImageRepository.findOne({
        where: { name: savedImageName, general: true },
      })
      if (generalSavedImage) {
        return generalSavedImage
      }

      throw new NotFoundException(`Saved image with name ${savedImageName} not found`)
    }

    return savedImage
  }

  async setSavedImageGeneralStatus(savedImageId: string, general: boolean) {
    const savedImage = await this.savedImageRepository.findOne({
      where: { id: savedImageId },
    })

    if (!savedImage) {
      throw new NotFoundException(`SavedImage ${savedImageId} not found`)
    }

    savedImage.general = general
    return await this.savedImageRepository.save(savedImage)
  }

  async getBuildLogsUrl(savedImage: SavedImage): Promise<string> {
    if (!savedImage.initialRunnerId) {
      throw new NotFoundException(`SavedImage ${savedImage.id} has no initial runner`)
    }

    const runner = await this.runnerService.findOneOrFail(savedImage.initialRunnerId)
    const region = await this.regionService.findOne(runner.region, true)

    if (!region) {
      throw new NotFoundException(`Region for initial runner for savedImage ${savedImage.id} not found`)
    }

    if (!region.proxyUrl) {
      return `${this.configService.getOrThrow('proxy.protocol')}://${this.configService.getOrThrow('proxy.domain')}/saved-images/${savedImage.id}/build-logs`
    }

    return region.proxyUrl + '/saved-images/' + savedImage.id + '/build-logs'
  }

  private async validateOrganizationQuotas(
    organization: Organization,
    addedSavedImageCount: number,
    cpu?: number,
    memory?: number,
    disk?: number,
  ): Promise<{
    pendingSavedImageCountIncremented: boolean
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
    await this.organizationUsageService.incrementPendingSavedImageUsage(organization.id, addedSavedImageCount)

    const usageOverview = await this.organizationUsageService.getSavedImageUsageOverview(organization.id)

    try {
      if (usageOverview.currentSavedImageUsage + usageOverview.pendingSavedImageUsage > organization.savedImageQuota) {
        throw new ForbiddenException(`SavedImage quota exceeded. Maximum allowed: ${organization.savedImageQuota}`)
      }
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, addedSavedImageCount)
      throw error
    }

    return {
      pendingSavedImageCountIncremented: true,
    }
  }

  async rollbackPendingUsage(organizationId: string, pendingSavedImageCountIncrement?: number): Promise<void> {
    if (!pendingSavedImageCountIncrement) {
      return
    }

    try {
      await this.organizationUsageService.decrementPendingSavedImageUsage(organizationId, pendingSavedImageCountIncrement)
    } catch (error) {
      this.logger.error(`Error rolling back pending savedImage usage: ${error}`)
    }
  }

  @OnEvent(SandboxEvents.CREATED)
  private async handleSandboxCreatedEvent(event: SandboxCreatedEvent) {
    if (!event.sandbox.savedImage) {
      return
    }

    // Update once per minute at most
    if (!(await this.redisLockProvider.lock(`savedImage:${event.sandbox.savedImage}:update-last-used`, 60))) {
      return
    }

    const savedImage = await this.getSavedImageByName(event.sandbox.savedImage, event.sandbox.organizationId)
    savedImage.lastUsedAt = event.sandbox.createdAt
    await this.savedImageRepository.save(savedImage)
  }

  async activateSavedImage(savedImageId: string, organization: Organization): Promise<SavedImage> {
    const lockKey = `savedImage:${savedImageId}:activate`
    await this.redisLockProvider.waitForLock(lockKey, 60)

    let pendingSavedImageCountIncrement: number | undefined

    try {
      const savedImage = await this.savedImageRepository.findOne({
        where: { id: savedImageId },
      })

      if (!savedImage) {
        throw new NotFoundException(`SavedImage ${savedImageId} not found`)
      }

      if (savedImage.state === SavedImageState.ACTIVE) {
        throw new BadRequestException(`SavedImage ${savedImageId} is already active`)
      }

      if (savedImage.state !== SavedImageState.INACTIVE) {
        throw new BadRequestException(
          `SavedImage ${savedImageId} cannot be activated - it is in ${savedImage.state} state`,
        )
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const activatedSavedImageCount = 1

      const { pendingSavedImageCountIncremented } = await this.validateOrganizationQuotas(
        organization,
        activatedSavedImageCount,
        savedImage.cpu,
        savedImage.mem,
        savedImage.disk,
      )

      if (pendingSavedImageCountIncremented) {
        pendingSavedImageCountIncrement = activatedSavedImageCount
      }

      savedImage.state = SavedImageState.PENDING
      const savedSavedImage = await this.savedImageRepository.save(savedImage)

      this.eventEmitter.emit(SavedImageEvents.ACTIVATED, new SavedImageActivatedEvent(savedSavedImage))

      return savedSavedImage
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, pendingSavedImageCountIncrement)
      throw error
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  async canCleanupImage(imageName: string): Promise<boolean> {
    const savedImage = await this.savedImageRepository.findOne({
      where: {
        state: Not(In([SavedImageState.ERROR, SavedImageState.BUILD_FAILED])),
        artifactRef: imageName,
      },
    })

    if (savedImage) {
      return false
    }

    const sandbox = await this.sandboxRepository.findOne({
      where: [
        {
          existingBackupSnapshots: Raw((alias) => `${alias} @> '[{"snapshotName":"${imageName}"}]'::jsonb`),
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

  async deactivateSavedImage(savedImageId: string): Promise<void> {
    const savedImage = await this.savedImageRepository.findOne({
      where: { id: savedImageId },
    })

    if (!savedImage) {
      throw new NotFoundException(`SavedImage ${savedImageId} not found`)
    }

    if (savedImage.state === SavedImageState.INACTIVE) {
      return
    }

    savedImage.state = SavedImageState.INACTIVE
    await this.savedImageRepository.save(savedImage)

    try {
      const countActiveSavedImages = await this.savedImageRepository.count({
        where: {
          state: SavedImageState.ACTIVE,
          artifactRef: savedImage.artifactRef,
        },
      })

      if (countActiveSavedImages === 0) {
        // Set associated RunnerArtifactCache records to REMOVING state
        const result = await this.runnerArtifactCacheRepository.update(
          { artifactRef: savedImage.artifactRef },
          { state: RunnerArtifactCacheState.REMOVING },
        )
        this.logger.debug(
          `Deactivated savedImage ${savedImage.id} and marked ${result.affected} RunnerArtifactCaches for removal`,
        )
      }
    } catch (error) {
      this.logger.error(
        `Deactivated savedImage ${savedImage.id}, but failed to mark runner artifact caches for removal`,
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
   * Validates and returns a region ID for savedImage availability.
   *
   * @param organization - The organization which is creating the savedImage.
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
   * @param savedImageId
   * @returns The regions where the saved image is configured to be propagated to.
   */
  async getSavedImageRegions(savedImageId: string): Promise<Region[]> {
    return await this.regionRepository
      .createQueryBuilder('r')
      .innerJoin('saved_image_region', 'sr', 'sr."regionId" = r.id')
      .where('sr."savedImageId" = :savedImageId', { savedImageId })
      .getMany()
  }

  /**
   * @param savedImageId - The ID of the savedImage.
   * @param regionId - The ID of the region.
   * @returns true if the saved image is available in the region, false otherwise.
   */
  async isAvailableInRegion(savedImageId: string, regionId: string): Promise<boolean> {
    return await this.savedImageRegionRepository.exists({
      where: {
        savedImageId,
        regionId,
      },
    })
  }

  @OnEvent(OrganizationEvents.SUSPENDED_SAVED_IMAGE_DEACTIVATED)
  async handleSuspendedOrganizationSavedImageDeactivated(event: OrganizationSuspendedSavedImageDeactivatedEvent) {
    await this.deactivateSavedImage(event.savedImageId).catch((error) => {
      //  log the error for now, but don't throw it as it will be retried
      this.logger.error(
        `Error deactivating savedImage from suspended organization. SavedImageId: ${event.savedImageId}: `,
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
