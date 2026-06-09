/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  OnModuleInit,
  OnApplicationShutdown,
  ConflictException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, In, Not, Repository } from 'typeorm'
import { CreateOrganizationInternalDto } from '../dto/create-organization.internal.dto'
import { UpdateOrganizationQuotaDto } from '../dto/update-organization-quota.dto'
import { Organization } from '../entities/organization.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { UserEvents } from '../../user/constants/user-events.constant'
import { UserCreatedEvent } from '../../user/events/user-created.event'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'
import { Snapshot } from '../../box/entities/snapshot.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { OrganizationEvents } from '../constants/organization-events.constant'
import { CreateOrganizationQuotaDto } from '../dto/create-organization-quota.dto'
import { UserEmailVerifiedEvent } from '../../user/events/user-email-verified.event'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { OrganizationSuspendedBoxStoppedEvent } from '../events/organization-suspended-box-stopped.event'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { SystemRole } from '../../user/enums/system-role.enum'
import { SnapshotState } from '../../box/enums/snapshot-state.enum'
import { OrganizationSuspendedSnapshotDeactivatedEvent } from '../events/organization-suspended-snapshot-deactivated.event'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { setTimeout } from 'timers/promises'
import { TypedConfigService } from '../../config/typed-config.service'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { RegionQuota } from '../entities/region-quota.entity'
import { UpdateOrganizationRegionQuotaDto } from '../dto/update-organization-region-quota.dto'
import { RegionService } from '../../region/services/region.service'
import { Region } from '../../region/entities/region.entity'
import { RegionQuotaDto } from '../dto/region-quota.dto'
import { RegionType } from '../../region/enums/region-type.enum'
import { RegionDto } from '../../region/dto/region.dto'
import { EncryptionService } from '../../encryption/encryption.service'
import { OtelConfigDto } from '../dto/otel-config.dto'
import { boxLookupCacheKeyByAuthToken } from '../../box/utils/box-lookup-cache.util'
import { BoxRepository } from '../../box/repositories/box.repository'

@Injectable()
export class OrganizationService implements OnModuleInit, TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()
  private readonly logger = new Logger(OrganizationService.name)
  private defaultOrganizationQuota: CreateOrganizationQuotaDto
  private defaultBoxLimitedNetworkEgress: boolean

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
    @InjectRepository(RegionQuota)
    private readonly regionQuotaRepository: Repository<RegionQuota>,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    private readonly regionService: RegionService,
    private readonly encryptionService: EncryptionService,
  ) {
    this.defaultOrganizationQuota = this.configService.getOrThrow('defaultOrganizationQuota')
    this.defaultBoxLimitedNetworkEgress = this.configService.getOrThrow('organizationBoxDefaultLimitedNetworkEgress')
  }

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await setTimeout(1000)
    }
  }

  async onModuleInit(): Promise<void> {
    await this.stopSuspendedOrganizationBoxes()
  }

  async create(
    createOrganizationDto: CreateOrganizationInternalDto,
    createdBy: string,
    personal = false,
    creatorEmailVerified = false,
  ): Promise<Organization> {
    return this.createWithEntityManager(
      this.organizationRepository.manager,
      createOrganizationDto,
      createdBy,
      creatorEmailVerified,
      personal,
    )
  }

  async findByUser(userId: string): Promise<Organization[]> {
    return this.organizationRepository.find({
      where: {
        users: {
          userId,
        },
      },
    })
  }

  async findOne(organizationId: string): Promise<Organization | null> {
    return this.organizationRepository.findOne({
      where: { id: organizationId },
    })
  }

  async findByBoxId(boxId: string): Promise<Organization | null> {
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })

    if (!box) {
      return null
    }

    return this.organizationRepository.findOne({ where: { id: box.organizationId } })
  }

  async findByBoxAuthToken(authToken: string): Promise<Organization | null> {
    const box = await this.boxRepository.findOne({
      where: { authToken },
      cache: {
        id: boxLookupCacheKeyByAuthToken({ authToken }),
        milliseconds: 10_000,
      },
    })

    if (!box) {
      return null
    }

    return this.organizationRepository.findOne({ where: { id: box.organizationId } })
  }

  async findPersonal(userId: string): Promise<Organization> {
    return this.findPersonalWithEntityManager(this.organizationRepository.manager, userId)
  }

  async delete(organizationId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    return this.removeWithEntityManager(this.organizationRepository.manager, organization)
  }

  async updateQuota(organizationId: string, updateDto: UpdateOrganizationQuotaDto): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.maxCpuPerBox = updateDto.maxCpuPerBox ?? organization.maxCpuPerBox
    organization.maxMemoryPerBox = updateDto.maxMemoryPerBox ?? organization.maxMemoryPerBox
    organization.maxDiskPerBox = updateDto.maxDiskPerBox ?? organization.maxDiskPerBox
    organization.maxSnapshotSize = updateDto.maxSnapshotSize ?? organization.maxSnapshotSize
    organization.volumeQuota = updateDto.volumeQuota ?? organization.volumeQuota
    organization.snapshotQuota = updateDto.snapshotQuota ?? organization.snapshotQuota
    organization.authenticatedRateLimit = updateDto.authenticatedRateLimit ?? organization.authenticatedRateLimit
    organization.boxCreateRateLimit = updateDto.boxCreateRateLimit ?? organization.boxCreateRateLimit
    organization.boxLifecycleRateLimit = updateDto.boxLifecycleRateLimit ?? organization.boxLifecycleRateLimit
    organization.authenticatedRateLimitTtlSeconds =
      updateDto.authenticatedRateLimitTtlSeconds ?? organization.authenticatedRateLimitTtlSeconds
    organization.boxCreateRateLimitTtlSeconds =
      updateDto.boxCreateRateLimitTtlSeconds ?? organization.boxCreateRateLimitTtlSeconds
    organization.boxLifecycleRateLimitTtlSeconds =
      updateDto.boxLifecycleRateLimitTtlSeconds ?? organization.boxLifecycleRateLimitTtlSeconds
    organization.snapshotDeactivationTimeoutMinutes =
      updateDto.snapshotDeactivationTimeoutMinutes ?? organization.snapshotDeactivationTimeoutMinutes

    await this.organizationRepository.save(organization)
  }

  async updateRegionQuota(
    organizationId: string,
    regionId: string,
    updateDto: UpdateOrganizationRegionQuotaDto,
  ): Promise<void> {
    const regionQuota = await this.regionQuotaRepository.findOne({ where: { organizationId, regionId } })
    if (!regionQuota) {
      throw new NotFoundException('Region not found')
    }

    regionQuota.totalCpuQuota = updateDto.totalCpuQuota ?? regionQuota.totalCpuQuota
    regionQuota.totalMemoryQuota = updateDto.totalMemoryQuota ?? regionQuota.totalMemoryQuota
    regionQuota.totalDiskQuota = updateDto.totalDiskQuota ?? regionQuota.totalDiskQuota

    await this.regionQuotaRepository.save(regionQuota)
  }

  async getRegionQuotas(organizationId: string): Promise<RegionQuotaDto[]> {
    const regionQuotas = await this.regionQuotaRepository.find({ where: { organizationId } })
    return regionQuotas.map((regionQuota) => new RegionQuotaDto(regionQuota))
  }

  async getRegionQuota(organizationId: string, regionId: string): Promise<RegionQuotaDto | null> {
    const regionQuota = await this.regionQuotaRepository.findOne({ where: { organizationId, regionId } })
    if (!regionQuota) {
      return null
    }
    return new RegionQuotaDto(regionQuota)
  }

  async getRegionQuotaByBoxId(boxId: string): Promise<RegionQuotaDto | null> {
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })
    if (!box) {
      return null
    }
    return this.getRegionQuota(box.organizationId, box.region)
  }

  /**
   * Lists all available regions for the organization.
   *
   * A region is available for the organization if either:
   * - It is directly associated with the organization, or
   * - It is not associated with any organization, but the organization has quotas allocated for the region or quotas are not enforced for the region
   *
   * @param organizationId - The organization ID.
   * @returns The available regions
   */
  async listAvailableRegions(organizationId: string): Promise<RegionDto[]> {
    const regions = await this.regionRepository
      .createQueryBuilder('region')
      .where('region."regionType" = :customRegionType AND region."organizationId" = :organizationId', {
        customRegionType: RegionType.CUSTOM,
        organizationId,
      })
      .orWhere('region."regionType" IN (:...otherRegionTypes) AND region."enforceQuotas" = false', {
        otherRegionTypes: [RegionType.DEDICATED, RegionType.SHARED],
      })
      .orWhere(
        'region."regionType" IN (:...otherRegionTypes) AND region."enforceQuotas" = true AND EXISTS (SELECT 1 FROM region_quota rq WHERE rq."regionId" = region."id" AND rq."organizationId" = :organizationId)',
        {
          otherRegionTypes: [RegionType.DEDICATED, RegionType.SHARED],
          organizationId,
        },
      )
      .orderBy(
        `CASE region."regionType"
          WHEN '${RegionType.CUSTOM}' THEN 1
          WHEN '${RegionType.DEDICATED}' THEN 2
          WHEN '${RegionType.SHARED}' THEN 3
          ELSE 4
        END`,
      )
      .getMany()

    return regions.map(RegionDto.fromRegion)
  }

  async suspend(
    organizationId: string,
    suspensionReason?: string,
    suspendedUntil?: Date,
    suspensionCleanupGracePeriodHours?: number,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.suspended = true
    organization.suspensionReason = suspensionReason || null
    organization.suspendedUntil = suspendedUntil || null
    organization.suspendedAt = new Date()
    if (suspensionCleanupGracePeriodHours) {
      organization.suspensionCleanupGracePeriodHours = suspensionCleanupGracePeriodHours
    }

    await this.organizationRepository.save(organization)
  }

  async unsuspend(organizationId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    organization.suspended = false
    organization.suspensionReason = null
    organization.suspendedUntil = null
    organization.suspendedAt = null

    await this.organizationRepository.save(organization)
  }

  async updateBoxDefaultLimitedNetworkEgress(
    organizationId: string,
    boxDefaultLimitedNetworkEgress: boolean,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }
    organization.boxLimitedNetworkEgress = boxDefaultLimitedNetworkEgress

    await this.organizationRepository.save(organization)
  }

  /**
   * @param organizationId - The ID of the organization.
   * @param defaultRegionId - The ID of the region to set as the default region.
   * @throws {NotFoundException} If the organization is not found.
   * @throws {ConflictException} If the organization already has a default region set.
   */
  async setDefaultRegion(organizationId: string, defaultRegionId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    if (organization.defaultRegionId) {
      throw new ConflictException('Organization already has a default region set')
    }

    const defaultRegion = await this.validateOrganizationDefaultRegion(defaultRegionId)
    organization.defaultRegionId = defaultRegionId

    if (defaultRegion.enforceQuotas) {
      const regionQuota = new RegionQuota(
        organization.id,
        defaultRegionId,
        this.defaultOrganizationQuota.totalCpuQuota,
        this.defaultOrganizationQuota.totalMemoryQuota,
        this.defaultOrganizationQuota.totalDiskQuota,
      )
      if (organization.regionQuotas) {
        organization.regionQuotas = [...organization.regionQuotas, regionQuota]
      } else {
        organization.regionQuotas = [regionQuota]
      }
    }

    await this.organizationRepository.save(organization)
  }

  async updateExperimentalConfig(
    organizationId: string,
    experimentalConfig: Record<string, any> | null,
  ): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    const existingConfig = organization._experimentalConfig

    organization._experimentalConfig = await this.validatedExperimentalConfig(experimentalConfig)

    // If experimentalConfig contains redacted fields, we need to preserve the existing encrypted values
    if (experimentalConfig && experimentalConfig.otel && experimentalConfig.otel.headers) {
      if (existingConfig && existingConfig.otel && existingConfig.otel.headers) {
        for (const [key, value] of Object.entries(experimentalConfig.otel.headers)) {
          if (
            typeof value === 'string' &&
            value.match(/\*/g)?.length === value.length &&
            existingConfig.otel.headers[key]
          ) {
            organization._experimentalConfig.otel.headers[key] = existingConfig.otel.headers[key]
          }
        }
      }
    }

    await this.organizationRepository.save(organization)
  }

  async getOtelConfigByBoxAuthToken(boxAuthToken: string): Promise<OtelConfigDto | null> {
    const organization = await this.findByBoxAuthToken(boxAuthToken)
    if (!organization) {
      return null
    }

    if (!organization._experimentalConfig || !organization._experimentalConfig.otel) {
      return null
    }

    const otelConfig = organization._experimentalConfig.otel
    const decryptedHeaders: Record<string, string> = {}
    if (otelConfig.headers && typeof otelConfig.headers === 'object') {
      for (const [key, value] of Object.entries(otelConfig.headers)) {
        if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
          decryptedHeaders[key] = await this.encryptionService.decrypt(value)
        }
      }
    }

    return {
      endpoint: otelConfig.endpoint,
      headers: Object.keys(decryptedHeaders).length > 0 ? decryptedHeaders : undefined,
    }
  }

  private async validatedExperimentalConfig(
    experimentalConfig: Record<string, any> | null,
  ): Promise<Record<string, any> | null> {
    if (!experimentalConfig) {
      return null
    }

    if (!experimentalConfig.otel) {
      return experimentalConfig
    }

    const otelConfig = { ...experimentalConfig.otel }
    if (typeof otelConfig.endpoint !== 'string' || !otelConfig.endpoint.trim()) {
      throw new ForbiddenException('Invalid OpenTelemetry endpoint')
    }

    if (otelConfig.headers && typeof otelConfig.headers === 'object') {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(otelConfig.headers)) {
        if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
          headers[key] = await this.encryptionService.encrypt(value)
        }
      }
      otelConfig.headers = headers
    } else {
      otelConfig.headers = {}
    }

    return {
      ...experimentalConfig,
      otel: otelConfig,
    }
  }

  private async createWithEntityManager(
    entityManager: EntityManager,
    createOrganizationDto: CreateOrganizationInternalDto,
    createdBy: string,
    creatorEmailVerified: boolean,
    personal = false,
    quota: CreateOrganizationQuotaDto = this.defaultOrganizationQuota,
    boxLimitedNetworkEgress: boolean = this.defaultBoxLimitedNetworkEgress,
  ): Promise<Organization> {
    if (personal) {
      const count = await entityManager.count(Organization, {
        where: { createdBy, personal: true },
      })
      if (count > 0) {
        throw new ForbiddenException('Personal organization already exists')
      }
    }

    // set some limit to the number of created organizations
    const createdCount = await entityManager.count(Organization, {
      where: { createdBy },
    })
    if (createdCount >= 10) {
      throw new ForbiddenException('You have reached the maximum number of created organizations')
    }

    let organization = new Organization(createOrganizationDto.defaultRegionId)

    organization.name = createOrganizationDto.name
    organization.createdBy = createdBy
    organization.personal = personal

    organization.maxCpuPerBox = quota.maxCpuPerBox
    organization.maxMemoryPerBox = quota.maxMemoryPerBox
    organization.maxDiskPerBox = quota.maxDiskPerBox
    organization.snapshotQuota = quota.snapshotQuota
    organization.maxSnapshotSize = quota.maxSnapshotSize
    organization.volumeQuota = quota.volumeQuota

    if (!creatorEmailVerified && !this.configService.get('skipUserEmailVerification')) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Please verify your email address'
    } else if (this.configService.get('billingApiUrl') && !personal) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Payment method required'
    }

    organization.boxLimitedNetworkEgress = boxLimitedNetworkEgress

    const owner = new OrganizationUser()
    owner.userId = createdBy
    owner.role = OrganizationMemberRole.OWNER

    organization.users = [owner]

    if (createOrganizationDto.defaultRegionId) {
      const defaultRegion = await this.validateOrganizationDefaultRegion(createOrganizationDto.defaultRegionId)

      if (defaultRegion.enforceQuotas) {
        const regionQuota = new RegionQuota(
          organization.id,
          createOrganizationDto.defaultRegionId,
          quota.totalCpuQuota,
          quota.totalMemoryQuota,
          quota.totalDiskQuota,
        )
        organization.regionQuotas = [regionQuota]
      }
    }

    await entityManager.transaction(async (em) => {
      organization = await em.save(organization)
      await this.eventEmitter.emitAsync(OrganizationEvents.CREATED, organization)
    })

    return organization
  }

  private async removeWithEntityManager(
    entityManager: EntityManager,
    organization: Organization,
    force = false,
  ): Promise<void> {
    if (!force) {
      if (organization.personal) {
        throw new ForbiddenException('Cannot delete personal organization')
      }
    }
    await entityManager.remove(organization)
  }

  private async unsuspendPersonalWithEntityManager(entityManager: EntityManager, userId: string): Promise<void> {
    const organization = await this.findPersonalWithEntityManager(entityManager, userId)

    organization.suspended = false
    organization.suspendedAt = null
    organization.suspensionReason = null
    organization.suspendedUntil = null
    await entityManager.save(organization)
  }

  private async findPersonalWithEntityManager(entityManager: EntityManager, userId: string): Promise<Organization> {
    const organization = await entityManager.findOne(Organization, {
      where: { createdBy: userId, personal: true },
    })

    if (!organization) {
      throw new NotFoundException(`Personal organization for user ${userId} not found`)
    }

    return organization
  }

  /**
   * @throws NotFoundException - If the region is not found or not available to the organization
   */
  async validateOrganizationDefaultRegion(defaultRegionId: string): Promise<Region> {
    const region = await this.regionService.findOne(defaultRegionId)
    if (!region || region.regionType !== RegionType.SHARED) {
      throw new NotFoundException('Region not found')
    }

    return region
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'stop-suspended-organization-boxes' })
  @TrackJobExecution()
  @LogExecution('stop-suspended-organization-boxes')
  @WithInstrumentation()
  async stopSuspendedOrganizationBoxes(): Promise<void> {
    //  lock the sync to only run one instance at a time
    const lockKey = 'stop-suspended-organization-boxes'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    const queryResult = await this.organizationRepository
      .createQueryBuilder('organization')
      .select('id')
      .where('suspended = true')
      .andWhere(`"suspendedAt" < NOW() - INTERVAL '1 hour' * "suspensionCleanupGracePeriodHours"`)
      .andWhere(`"suspendedAt" > NOW() - INTERVAL '7 day'`)
      .andWhereExists(
        this.boxRepository
          .createQueryBuilder('box')
          .select('1')
          .where(
            `"box"."organizationId" = "organization"."id" AND "box"."desiredState" = '${BoxDesiredState.STARTED}' and "box"."state" NOT IN ('${BoxState.ERROR}', '${BoxState.BUILD_FAILED}')`,
          ),
      )
      .take(100)
      .getRawMany()

    const suspendedOrganizationIds = queryResult.map((result) => result.id)

    // Skip if no suspended organizations found to avoid empty IN clause
    if (suspendedOrganizationIds.length === 0) {
      await this.redisLockProvider.unlock(lockKey)
      return
    }

    const boxes = await this.boxRepository.find({
      where: {
        organizationId: In(suspendedOrganizationIds),
        desiredState: BoxDesiredState.STARTED,
        state: Not(In([BoxState.ERROR, BoxState.BUILD_FAILED])),
      },
    })

    boxes.map((box) =>
      this.eventEmitter.emitAsync(
        OrganizationEvents.SUSPENDED_BOX_STOPPED,
        new OrganizationSuspendedBoxStoppedEvent(box.id),
      ),
    )

    await this.redisLockProvider.unlock(lockKey)
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'deactivate-suspended-organization-snapshots' })
  @TrackJobExecution()
  @LogExecution('deactivate-suspended-organization-snapshots')
  @WithInstrumentation()
  async deactivateSuspendedOrganizationSnapshots(): Promise<void> {
    //  lock the sync to only run one instance at a time
    const lockKey = 'deactivate-suspended-organization-snapshots'
    if (!(await this.redisLockProvider.lock(lockKey, 60))) {
      return
    }

    const queryResult = await this.organizationRepository
      .createQueryBuilder('organization')
      .select('id')
      .where('suspended = true')
      .andWhere(`"suspendedAt" < NOW() - INTERVAL '1 hour' * "suspensionCleanupGracePeriodHours"`)
      .andWhere(`"suspendedAt" > NOW() - INTERVAL '7 day'`)
      .andWhereExists(
        this.snapshotRepository
          .createQueryBuilder('snapshot')
          .select('1')
          .where('snapshot.organizationId = organization.id')
          .andWhere(`snapshot.state = '${SnapshotState.ACTIVE}'`)
          .andWhere(`snapshot.general = false`),
      )
      .take(100)
      .getRawMany()

    const suspendedOrganizationIds = queryResult.map((result) => result.id)

    // Skip if no suspended organizations found to avoid empty IN clause
    if (suspendedOrganizationIds.length === 0) {
      await this.redisLockProvider.unlock(lockKey)
      return
    }

    const snapshotQueryResult = await this.snapshotRepository
      .createQueryBuilder('snapshot')
      .select('id')
      .where('snapshot.organizationId IN (:...suspendedOrgIds)', { suspendedOrgIds: suspendedOrganizationIds })
      .andWhere(`snapshot.state = '${SnapshotState.ACTIVE}'`)
      .andWhere(`snapshot.general = false`)
      .take(100)
      .getRawMany()

    const snapshotIds = snapshotQueryResult.map((result) => result.id)

    snapshotIds.map((id) =>
      this.eventEmitter.emitAsync(
        OrganizationEvents.SUSPENDED_SNAPSHOT_DEACTIVATED,
        new OrganizationSuspendedSnapshotDeactivatedEvent(id),
      ),
    )

    await this.redisLockProvider.unlock(lockKey)
  }

  @OnAsyncEvent({
    event: UserEvents.CREATED,
  })
  @TrackJobExecution()
  async handleUserCreatedEvent(payload: UserCreatedEvent): Promise<Organization> {
    return this.createWithEntityManager(
      payload.entityManager,
      {
        name: 'Personal',
        defaultRegionId: payload.personalOrganizationDefaultRegionId,
      },
      payload.user.id,
      payload.user.role === SystemRole.ADMIN ? true : payload.user.emailVerified,
      true,
      payload.personalOrganizationQuota,
      payload.user.role === SystemRole.ADMIN ? false : undefined,
    )
  }

  @OnAsyncEvent({
    event: UserEvents.EMAIL_VERIFIED,
  })
  @TrackJobExecution()
  async handleUserEmailVerifiedEvent(payload: UserEmailVerifiedEvent): Promise<void> {
    await this.unsuspendPersonalWithEntityManager(payload.entityManager, payload.userId)
  }

  @OnAsyncEvent({
    event: UserEvents.DELETED,
  })
  @TrackJobExecution()
  async handleUserDeletedEvent(payload: UserDeletedEvent): Promise<void> {
    const organization = await this.findPersonalWithEntityManager(payload.entityManager, payload.userId)

    await this.removeWithEntityManager(payload.entityManager, organization, true)
  }

  assertOrganizationIsNotSuspended(organization: Organization): void {
    if (!organization.suspended) {
      return
    }

    if (organization.suspendedUntil ? organization.suspendedUntil > new Date() : true) {
      if (organization.suspensionReason) {
        throw new ForbiddenException(`Organization is suspended: ${organization.suspensionReason}`)
      } else {
        throw new ForbiddenException('Organization is suspended')
      }
    }
  }
}
