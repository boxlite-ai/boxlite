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
  BadRequestException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, In, Not, Repository } from 'typeorm'
import { CreateOrganizationInternalDto } from '../dto/create-organization.internal.dto'
import { Organization } from '../entities/organization.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { UserEvents } from '../../user/constants/user-events.constant'
import { UserCreatedEvent } from '../../user/events/user-created.event'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'
import { BoxState } from '../../box/enums/box-state.enum'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { OrganizationEvents } from '../constants/organization-events.constant'
import { UserEmailVerifiedEvent } from '../../user/events/user-email-verified.event'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { OrganizationSuspendedBoxStoppedEvent } from '../events/organization-suspended-box-stopped.event'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { SystemRole } from '../../user/enums/system-role.enum'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { setTimeout } from 'timers/promises'
import { TypedConfigService } from '../../config/typed-config.service'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { RegionService } from '../../region/services/region.service'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { RegionDto } from '../../region/dto/region.dto'
import { EncryptionService } from '../../encryption/encryption.service'
import { OtelConfigDto } from '../dto/otel-config.dto'
import { boxLookupCacheKeyByAuthToken } from '../../box/utils/box-lookup-cache.util'
import { BoxRepository } from '../../box/repositories/box.repository'

@Injectable()
export class OrganizationService implements OnModuleInit, TrackableJobExecutions, OnApplicationShutdown {
  private static readonly DEFAULT_ORGANIZATION_NAME = 'Default Organization'

  activeJobs = new Set<string>()
  private readonly logger = new Logger(OrganizationService.name)
  private defaultBoxLimitedNetworkEgress: boolean

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly boxRepository: BoxRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
    @InjectRepository(Region)
    private readonly regionRepository: Repository<Region>,
    private readonly regionService: RegionService,
    private readonly encryptionService: EncryptionService,
  ) {
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
    defaultForCreator = false,
    creatorEmailVerified = false,
  ): Promise<Organization> {
    return this.createWithEntityManager(
      this.organizationRepository.manager,
      createOrganizationDto,
      createdBy,
      creatorEmailVerified,
      defaultForCreator,
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

  async findByIds(organizationIds: string[]): Promise<Organization[]> {
    if (organizationIds.length === 0) {
      return []
    }

    return this.organizationRepository.find({
      where: { id: In(organizationIds) },
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

  async findDefaultForUser(userId: string): Promise<Organization> {
    return this.findDefaultForUserWithEntityManager(this.organizationRepository.manager, userId)
  }

  async findByUserWithDefaultFlag(
    userId: string,
  ): Promise<{ organization: Organization; isDefaultForAuthenticatedUser: boolean }[]> {
    const memberships = await this.organizationRepository.manager.find(OrganizationUser, {
      where: { userId },
      relations: {
        organization: true,
      },
      order: {
        createdAt: 'ASC',
      },
    })

    return memberships.map((membership) => ({
      organization: membership.organization,
      isDefaultForAuthenticatedUser: membership.isDefaultForUser,
    }))
  }

  async delete(organizationId: string): Promise<void> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })

    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    return this.removeWithEntityManager(this.organizationRepository.manager, organization)
  }

  async updateName(organizationId: string, name: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } })
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }

    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new BadRequestException('Organization name is required')
    }

    organization.name = trimmedName

    return this.organizationRepository.save(organization)
  }

  /**
   * Lists all available regions for the organization.
   *
   * A region is available for the organization if either:
   * - It is directly associated with the organization, or
   * - It is not associated with any organization and quotas are not enforced for the region
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

    await this.validateOrganizationDefaultRegion(defaultRegionId)
    organization.defaultRegionId = defaultRegionId

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
    defaultForCreator = false,
    boxLimitedNetworkEgress: boolean = this.defaultBoxLimitedNetworkEgress,
  ): Promise<Organization> {
    if (defaultForCreator) {
      const count = await entityManager.count(OrganizationUser, {
        where: {
          userId: createdBy,
          isDefaultForUser: true,
        },
      })
      if (count > 0) {
        throw new ForbiddenException('Default organization already exists for user')
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

    if (!creatorEmailVerified && !this.configService.get('skipUserEmailVerification')) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Please verify your email address'
    } else if (this.configService.get('billingApiUrl') && !defaultForCreator) {
      organization.suspended = true
      organization.suspendedAt = new Date()
      organization.suspensionReason = 'Payment method required'
    }

    organization.boxLimitedNetworkEgress = boxLimitedNetworkEgress

    const owner = new OrganizationUser()
    owner.userId = createdBy
    owner.role = OrganizationMemberRole.OWNER
    owner.isDefaultForUser = defaultForCreator

    organization.users = [owner]

    if (createOrganizationDto.defaultRegionId) {
      await this.validateOrganizationDefaultRegion(createOrganizationDto.defaultRegionId)
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
      const defaultMembershipsCount = await entityManager.count(OrganizationUser, {
        where: {
          organizationId: organization.id,
          isDefaultForUser: true,
        },
      })

      if (defaultMembershipsCount > 0) {
        throw new ForbiddenException("Cannot delete an organization while it is a user's default organization")
      }
    }
    await entityManager.remove(organization)
  }

  private async unsuspendDefaultForUserWithEntityManager(entityManager: EntityManager, userId: string): Promise<void> {
    const organization = await this.findDefaultForUserWithEntityManager(entityManager, userId)

    organization.suspended = false
    organization.suspendedAt = null
    organization.suspensionReason = null
    organization.suspendedUntil = null
    await entityManager.save(organization)
  }

  private async findDefaultForUserWithEntityManager(
    entityManager: EntityManager,
    userId: string,
  ): Promise<Organization> {
    const membership = await entityManager.findOne(OrganizationUser, {
      where: {
        userId,
        isDefaultForUser: true,
      },
      relations: {
        organization: true,
      },
    })

    if (!membership?.organization) {
      throw new NotFoundException(`Default organization for user ${userId} not found`)
    }

    return membership.organization
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
            `"box"."organizationId" = "organization"."id" AND "box"."desiredState" = '${BoxDesiredState.STARTED}' and "box"."state" NOT IN ('${BoxState.ERROR}')`,
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
        state: Not(In([BoxState.ERROR])),
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

  // TODO(image-rewrite): deactivateSuspendedOrganizationTemplates cron removed with box_template;
  // rebuild suspended-org template cleanup once the image/template model lands.

  @OnAsyncEvent({
    event: UserEvents.CREATED,
  })
  @TrackJobExecution()
  async handleUserCreatedEvent(payload: UserCreatedEvent): Promise<Organization> {
    return this.createWithEntityManager(
      payload.entityManager,
      {
        name: OrganizationService.DEFAULT_ORGANIZATION_NAME,
        defaultRegionId: payload.defaultOrganizationDefaultRegionId,
      },
      payload.user.id,
      payload.user.role === SystemRole.ADMIN ? true : payload.user.emailVerified,
      true,
      payload.user.role === SystemRole.ADMIN ? false : undefined,
    )
  }

  @OnAsyncEvent({
    event: UserEvents.EMAIL_VERIFIED,
  })
  @TrackJobExecution()
  async handleUserEmailVerifiedEvent(payload: UserEmailVerifiedEvent): Promise<void> {
    await this.unsuspendDefaultForUserWithEntityManager(payload.entityManager, payload.userId)
  }

  @OnAsyncEvent({
    event: UserEvents.DELETED,
  })
  @TrackJobExecution()
  async handleUserDeletedEvent(payload: UserDeletedEvent): Promise<void> {
    const organization = await this.findDefaultForUserWithEntityManager(payload.entityManager, payload.userId)
    const membersCount = await payload.entityManager.count(OrganizationUser, {
      where: {
        organizationId: organization.id,
      },
    })

    if (membersCount <= 1) {
      await this.removeWithEntityManager(payload.entityManager, organization, true)
      return
    }

    const deletedUserMembership = await payload.entityManager.findOne(OrganizationUser, {
      where: {
        organizationId: organization.id,
        userId: payload.userId,
      },
    })

    if (!deletedUserMembership) {
      return
    }

    if (deletedUserMembership.role === OrganizationMemberRole.OWNER) {
      const otherOwnersCount = await payload.entityManager.count(OrganizationUser, {
        where: {
          organizationId: organization.id,
          role: OrganizationMemberRole.OWNER,
          userId: Not(payload.userId),
        },
      })

      if (otherOwnersCount === 0) {
        const fallbackOwner = await payload.entityManager.findOne(OrganizationUser, {
          where: {
            organizationId: organization.id,
            userId: Not(payload.userId),
          },
          order: {
            createdAt: 'ASC',
          },
        })

        if (fallbackOwner) {
          fallbackOwner.role = OrganizationMemberRole.OWNER
          await payload.entityManager.save(fallbackOwner)
        }
      }
    }

    await payload.entityManager.remove(deletedUserMembership)
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
