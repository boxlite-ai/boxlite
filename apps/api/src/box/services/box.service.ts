/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Not, Repository, LessThan, In, JsonContains, FindOptionsWhere, ILike } from 'typeorm'
import { Box } from '../entities/box.entity'
import { CreateBoxDto } from '../dto/create-box.dto'
import { ResizeBoxDto } from '../dto/resize-box.dto'
import { BoxState } from '../enums/box-state.enum'
import { BoxClass } from '../enums/box-class.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerService } from './runner.service'
import { BoxError } from '../../exceptions/box-error.exception'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Cron, CronExpression } from '@nestjs/schedule'
import { BackupState } from '../enums/backup-state.enum'
import { Snapshot } from '../entities/snapshot.entity'
import { SnapshotState } from '../enums/snapshot-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { BoxWarmPoolService } from './box-warm-pool.service'
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter'
import { WarmPoolEvents } from '../constants/warmpool-events.constants'
import { WarmPoolTopUpRequested } from '../events/warmpool-topup-requested.event'
import { Runner } from '../entities/runner.entity'
import { Organization } from '../../organization/entities/organization.entity'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BuildInfo } from '../entities/build-info.entity'
import { generateBuildInfoHash as generateBuildSnapshotRef } from '../entities/build-info.entity'
import { BoxBackupCreatedEvent } from '../events/box-backup-created.event'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import { BoxStartedEvent } from '../events/box-started.event'
import { BoxStoppedEvent } from '../events/box-stopped.event'
import { BoxArchivedEvent } from '../events/box-archived.event'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { OrganizationSuspendedBoxStoppedEvent } from '../../organization/events/organization-suspended-box-stopped.event'
import { TypedConfigService } from '../../config/typed-config.service'
import { WarmPool } from '../entities/warm-pool.entity'
import { BoxDto, BoxVolume } from '../dto/box.dto'
import { isValidUuid } from '../../common/utils/uuid'
import { RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { validateNetworkAllowList } from '../utils/network-validation.util'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
import { SshAccess } from '../entities/ssh-access.entity'
import { SshAccessDto, SshAccessValidationDto } from '../dto/ssh-access.dto'
import { VolumeService } from './volume.service'
import { PaginatedList } from '../../common/interfaces/paginated-list.interface'
import {
  BoxSortField,
  BoxSortDirection,
  DEFAULT_BOX_SORT_FIELD,
  DEFAULT_BOX_SORT_DIRECTION,
} from '../dto/list-boxes-query.dto'
import { createRangeFilter } from '../../common/utils/range-filter'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import {
  UPGRADE_TIER_MESSAGE,
  ARCHIVE_BOXES_MESSAGE,
  PER_BOX_LIMIT_MESSAGE,
} from '../../common/constants/error-messages'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { customAlphabet as customNanoid, nanoid, urlAlphabet } from 'nanoid'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { validateMountPaths, validateSubpaths } from '../utils/volume-mount-path-validation.util'
import { BoxRepository } from '../repositories/box.repository'
import { PortPreviewUrlDto, SignedPortPreviewUrlDto } from '../dto/port-preview-url.dto'
import { RegionService } from '../../region/services/region.service'
import { DefaultRegionRequiredException } from '../../organization/exceptions/DefaultRegionRequiredException'
import { SnapshotService } from './snapshot.service'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxCreatedEvent } from '../events/box-create.event'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import {
  BOX_LOOKUP_CACHE_TTL_MS,
  BOX_ORG_ID_CACHE_TTL_MS,
  TOOLBOX_PROXY_URL_CACHE_TTL_S,
  boxLookupCacheKeyById,
  boxLookupCacheKeyByName,
  boxOrgIdCacheKeyById,
  boxOrgIdCacheKeyByName,
  toolboxProxyUrlCacheKey,
} from '../utils/box-lookup-cache.util'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { Region } from '../../region/entities/region.entity'
import { BoxActivityService } from './box-activity.service'

const DEFAULT_CPU = 1
const DEFAULT_MEMORY = 1
const DEFAULT_DISK = 3
const DEFAULT_GPU = 0

@Injectable()
export class BoxService {
  private readonly logger = new Logger(BoxService.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    @InjectRepository(BuildInfo)
    private readonly buildInfoRepository: Repository<BuildInfo>,
    @InjectRepository(SshAccess)
    private readonly sshAccessRepository: Repository<SshAccess>,
    private readonly runnerService: RunnerService,
    private readonly volumeService: VolumeService,
    private readonly configService: TypedConfigService,
    private readonly warmPoolService: BoxWarmPoolService,
    private readonly eventEmitter: EventEmitter2,
    private readonly organizationService: OrganizationService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly organizationUsageService: OrganizationUsageService,
    private readonly redisLockProvider: RedisLockProvider,
    @InjectRedis() private readonly redis: Redis,
    private readonly regionService: RegionService,
    private readonly snapshotService: SnapshotService,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
    private readonly boxActivityService: BoxActivityService,
  ) {}

  protected getLockKey(id: string): string {
    return `box:${id}:state-change`
  }

  private assertBoxNotErrored(box: Box): void {
    if ([BoxState.ERROR, BoxState.BUILD_FAILED].includes(box.state)) {
      throw new BoxError('Box is in an errored state')
    }
  }

  private async validateOrganizationQuotas(
    organization: Organization,
    region: Region,
    cpu: number,
    memory: number,
    disk: number,
    excludeBoxId?: string,
  ): Promise<{
    pendingCpuIncremented: boolean
    pendingMemoryIncremented: boolean
    pendingDiskIncremented: boolean
  }> {
    // validate per-box quotas
    if (cpu > organization.maxCpuPerBox) {
      throw new ForbiddenException(
        `CPU request ${cpu} exceeds maximum allowed per box (${organization.maxCpuPerBox}).\n${PER_BOX_LIMIT_MESSAGE}`,
      )
    }
    if (memory > organization.maxMemoryPerBox) {
      throw new ForbiddenException(
        `Memory request ${memory}GB exceeds maximum allowed per box (${organization.maxMemoryPerBox}GB).\n${PER_BOX_LIMIT_MESSAGE}`,
      )
    }
    if (disk > organization.maxDiskPerBox) {
      throw new ForbiddenException(
        `Disk request ${disk}GB exceeds maximum allowed per box (${organization.maxDiskPerBox}GB).\n${PER_BOX_LIMIT_MESSAGE}`,
      )
    }

    // e.g. region belonging to an organization
    if (!region.enforceQuotas) {
      return {
        pendingCpuIncremented: false,
        pendingMemoryIncremented: false,
        pendingDiskIncremented: false,
      }
    }

    const regionQuota = await this.organizationService.getRegionQuota(organization.id, region.id)

    if (!regionQuota) {
      if (region.regionType === RegionType.SHARED) {
        // region is public, but the organization does not have a quota for it
        throw new ForbiddenException(`Region ${region.id} is not available to the organization`)
      } else {
        // region is not public, respond as if the region was not found
        throw new NotFoundException('Region not found')
      }
    }

    // validate usage quotas
    const {
      cpuIncremented: pendingCpuIncremented,
      memoryIncremented: pendingMemoryIncremented,
      diskIncremented: pendingDiskIncremented,
    } = await this.organizationUsageService.incrementPendingBoxUsage(
      organization.id,
      region.id,
      cpu,
      memory,
      disk,
      excludeBoxId,
    )

    const usageOverview = await this.organizationUsageService.getBoxUsageOverview(
      organization.id,
      region.id,
      excludeBoxId,
    )

    try {
      const upgradeTierMessage = UPGRADE_TIER_MESSAGE(this.configService.getOrThrow('dashboardUrl'))

      if (usageOverview.currentCpuUsage + usageOverview.pendingCpuUsage > regionQuota.totalCpuQuota) {
        throw new ForbiddenException(
          `Total CPU limit exceeded. Maximum allowed: ${regionQuota.totalCpuQuota}.\n${upgradeTierMessage}`,
        )
      }

      if (usageOverview.currentMemoryUsage + usageOverview.pendingMemoryUsage > regionQuota.totalMemoryQuota) {
        throw new ForbiddenException(
          `Total memory limit exceeded. Maximum allowed: ${regionQuota.totalMemoryQuota}GiB.\n${upgradeTierMessage}`,
        )
      }

      if (usageOverview.currentDiskUsage + usageOverview.pendingDiskUsage > regionQuota.totalDiskQuota) {
        throw new ForbiddenException(
          `Total disk limit exceeded. Maximum allowed: ${regionQuota.totalDiskQuota}GiB.\n${ARCHIVE_BOXES_MESSAGE}\n${upgradeTierMessage}`,
        )
      }
    } catch (error) {
      await this.rollbackPendingUsage(
        organization.id,
        region.id,
        pendingCpuIncremented ? cpu : undefined,
        pendingMemoryIncremented ? memory : undefined,
        pendingDiskIncremented ? disk : undefined,
      )
      throw error
    }

    return {
      pendingCpuIncremented,
      pendingMemoryIncremented,
      pendingDiskIncremented,
    }
  }

  async rollbackPendingUsage(
    organizationId: string,
    regionId: string,
    pendingCpuIncrement?: number,
    pendingMemoryIncrement?: number,
    pendingDiskIncrement?: number,
  ): Promise<void> {
    if (!pendingCpuIncrement && !pendingMemoryIncrement && !pendingDiskIncrement) {
      return
    }

    try {
      await this.organizationUsageService.decrementPendingBoxUsage(
        organizationId,
        regionId,
        pendingCpuIncrement,
        pendingMemoryIncrement,
        pendingDiskIncrement,
      )
    } catch (error) {
      this.logger.error(`Error rolling back pending box usage: ${error}`)
    }
  }

  async archive(boxIdOrName: string, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    this.assertBoxNotErrored(box)

    if (String(box.state) !== String(box.desiredState)) {
      throw new BoxError('State change in progress')
    }

    if (box.state !== BoxState.STOPPED) {
      throw new BoxError('Box is not stopped')
    }

    if (box.pending) {
      throw new BoxError('Box state change in progress')
    }

    if (box.autoDeleteInterval === 0) {
      throw new BoxError('Ephemeral boxes cannot be archived')
    }

    const updateData: Partial<Box> = {
      state: BoxState.ARCHIVING,
      desiredState: BoxDesiredState.ARCHIVED,
    }

    const updatedBox = await this.boxRepository.updateWhere(box.id, {
      updateData,
      whereCondition: { pending: false, state: BoxState.STOPPED },
    })

    this.eventEmitter.emit(BoxEvents.ARCHIVED, new BoxArchivedEvent(updatedBox))
    return updatedBox
  }

  async createForWarmPool(warmPoolItem: WarmPool): Promise<Box> {
    const box = new Box(warmPoolItem.target)

    box.organizationId = BOX_WARM_POOL_UNASSIGNED_ORGANIZATION

    box.class = warmPoolItem.class
    box.snapshot = warmPoolItem.snapshot
    //  TODO: default user should be configurable
    box.osUser = 'boxlite'
    box.env = warmPoolItem.env || {}

    box.cpu = warmPoolItem.cpu
    box.gpu = warmPoolItem.gpu
    box.mem = warmPoolItem.mem
    box.disk = warmPoolItem.disk

    const snapshot = await this.snapshotRepository.findOne({
      where: [
        { organizationId: box.organizationId, name: box.snapshot, state: SnapshotState.ACTIVE },
        { general: true, name: box.snapshot, state: SnapshotState.ACTIVE },
      ],
    })
    if (!snapshot) {
      throw new BadRequestError(`Snapshot ${box.snapshot} not found while creating warm pool box`)
    }

    const runner = await this.runnerService.getRandomAvailableRunner({
      regions: [box.region],
      boxClass: box.class,
      snapshotRef: snapshot.ref,
    })

    box.runnerId = runner.id
    box.pending = true

    await this.boxRepository.insert(box)
    return box
  }

  async createFromSnapshot(
    createBoxDto: CreateBoxDto,
    organization: Organization,
    useBoxResourceParams_deprecated?: boolean,
  ): Promise<BoxDto> {
    let pendingCpuIncrement: number | undefined
    let pendingMemoryIncrement: number | undefined
    let pendingDiskIncrement: number | undefined

    const region = await this.getValidatedOrDefaultRegion(organization, createBoxDto.target)

    try {
      const boxClass = this.getValidatedOrDefaultClass(createBoxDto.class)

      let snapshotIdOrName = createBoxDto.snapshot

      if (!createBoxDto.snapshot?.trim()) {
        snapshotIdOrName = this.configService.getOrThrow('defaultSnapshot')
      }

      const snapshotFilter: FindOptionsWhere<Snapshot>[] = [
        { organizationId: organization.id, name: snapshotIdOrName },
        { general: true, name: snapshotIdOrName },
      ]

      if (isValidUuid(snapshotIdOrName)) {
        snapshotFilter.push(
          { organizationId: organization.id, id: snapshotIdOrName },
          { general: true, id: snapshotIdOrName },
        )
      }

      const snapshots = await this.snapshotRepository.find({
        where: snapshotFilter,
      })

      if (snapshots.length === 0) {
        throw new BadRequestError(
          `Snapshot ${snapshotIdOrName} not found. Did you add it through the BoxLite Dashboard?`,
        )
      }

      let snapshot = snapshots.find((s) => s.state === SnapshotState.ACTIVE)

      if (!snapshot) {
        snapshot = snapshots[0]
      }

      if (!(await this.snapshotService.isAvailableInRegion(snapshot.id, region.id))) {
        throw new BadRequestError(`Snapshot ${snapshotIdOrName} is not available in region ${region.id}`)
      }

      if (snapshot.state !== SnapshotState.ACTIVE) {
        throw new BadRequestError(`Snapshot ${snapshotIdOrName} is ${snapshot.state}`)
      }

      if (!snapshot.ref) {
        throw new BadRequestError('Snapshot ref is not defined')
      }

      let cpu = snapshot.cpu
      let mem = snapshot.mem
      let disk = snapshot.disk
      let gpu = snapshot.gpu

      // Remove the deprecated behavior in a future release
      if (useBoxResourceParams_deprecated) {
        if (createBoxDto.cpu) {
          cpu = createBoxDto.cpu
        }
        if (createBoxDto.memory) {
          mem = createBoxDto.memory
        }
        if (createBoxDto.disk) {
          disk = createBoxDto.disk
        }
        if (createBoxDto.gpu) {
          gpu = createBoxDto.gpu
        }
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const { pendingCpuIncremented, pendingMemoryIncremented, pendingDiskIncremented } =
        await this.validateOrganizationQuotas(organization, region, cpu, mem, disk)

      if (pendingCpuIncremented) {
        pendingCpuIncrement = cpu
      }
      if (pendingMemoryIncremented) {
        pendingMemoryIncrement = mem
      }
      if (pendingDiskIncremented) {
        pendingDiskIncrement = disk
      }

      if (!createBoxDto.volumes || createBoxDto.volumes.length === 0) {
        const skipWarmPool = (await this.redis.exists(`warm-pool:skip:${snapshot.id}`)) === 1

        if (!skipWarmPool) {
          const warmPoolBox = await this.warmPoolService.fetchWarmPoolBox({
            organizationId: organization.id,
            snapshot,
            target: region.id,
            class: createBoxDto.class,
            cpu: cpu,
            mem: mem,
            disk: disk,
            gpu: gpu,
            osUser: createBoxDto.user,
            env: createBoxDto.env,
            state: BoxState.STARTED,
          })

          if (warmPoolBox) {
            return await this.assignWarmPoolBox(warmPoolBox, createBoxDto, organization)
          }
        }
      } else {
        const volumeIdOrNames = createBoxDto.volumes.map((v) => v.volumeId)
        await this.volumeService.validateVolumes(organization.id, volumeIdOrNames)
      }

      const runner = await this.runnerService.getRandomAvailableRunner({
        regions: [region.id],
        boxClass,
        snapshotRef: snapshot.ref,
      })

      const box = new Box(region.id, createBoxDto.name)

      box.organizationId = organization.id

      //  TODO: make configurable
      box.class = boxClass
      box.snapshot = snapshot.name
      //  TODO: default user should be configurable
      box.osUser = createBoxDto.user || 'boxlite'
      box.env = createBoxDto.env || {}
      box.labels = createBoxDto.labels || {}

      box.cpu = cpu
      box.gpu = gpu
      box.mem = mem
      box.disk = disk

      box.public = createBoxDto.public || false

      if (createBoxDto.networkBlockAll !== undefined) {
        box.networkBlockAll = createBoxDto.networkBlockAll
      }

      if (createBoxDto.networkAllowList !== undefined) {
        box.networkAllowList = this.resolveNetworkAllowList(createBoxDto.networkAllowList)
      }

      if (createBoxDto.autoStopInterval !== undefined) {
        box.autoStopInterval = this.resolveAutoStopInterval(createBoxDto.autoStopInterval)
      }

      if (createBoxDto.autoArchiveInterval !== undefined) {
        box.autoArchiveInterval = this.resolveAutoArchiveInterval(createBoxDto.autoArchiveInterval)
      }

      if (createBoxDto.autoDeleteInterval !== undefined) {
        box.autoDeleteInterval = createBoxDto.autoDeleteInterval
      }

      if (createBoxDto.volumes !== undefined) {
        box.volumes = this.resolveVolumes(createBoxDto.volumes)
      }

      box.runnerId = runner.id
      box.pending = true

      const insertedBox = await this.boxRepository.insert(box)

      this.eventEmitter
        .emitAsync(BoxEvents.CREATED, new BoxCreatedEvent(insertedBox))
        .catch((err) => this.logger.error('Failed to emit BoxCreatedEvent', err))

      return this.toBoxDto(insertedBox)
    } catch (error) {
      await this.rollbackPendingUsage(
        organization.id,
        region.id,
        pendingCpuIncrement,
        pendingMemoryIncrement,
        pendingDiskIncrement,
      )

      if (error.code === '23505') {
        throw new ConflictException(`Box with name ${createBoxDto.name} already exists`)
      }

      throw error
    }
  }

  private async assignWarmPoolBox(
    warmPoolBox: Box,
    createBoxDto: CreateBoxDto,
    organization: Organization,
  ): Promise<BoxDto> {
    const now = new Date()
    const updateData: Partial<Box> = {
      public: createBoxDto.public || false,
      labels: createBoxDto.labels || {},
      organizationId: organization.id,
      createdAt: now,
    }

    if (createBoxDto.name) {
      updateData.name = createBoxDto.name
    }

    if (createBoxDto.autoStopInterval !== undefined) {
      updateData.autoStopInterval = this.resolveAutoStopInterval(createBoxDto.autoStopInterval)
    }

    if (createBoxDto.autoArchiveInterval !== undefined) {
      updateData.autoArchiveInterval = this.resolveAutoArchiveInterval(createBoxDto.autoArchiveInterval)
    }

    if (createBoxDto.autoDeleteInterval !== undefined) {
      updateData.autoDeleteInterval = createBoxDto.autoDeleteInterval
    }

    if (createBoxDto.networkBlockAll !== undefined) {
      updateData.networkBlockAll = createBoxDto.networkBlockAll
    }

    if (createBoxDto.networkAllowList !== undefined) {
      updateData.networkAllowList = this.resolveNetworkAllowList(createBoxDto.networkAllowList)
    }

    if (!warmPoolBox.runnerId) {
      throw new BoxError('Runner not found for warm pool box')
    }

    if (
      createBoxDto.networkBlockAll !== undefined ||
      createBoxDto.networkAllowList !== undefined ||
      organization.boxLimitedNetworkEgress
    ) {
      const runner = await this.runnerService.findOneOrFail(warmPoolBox.runnerId)
      const runnerAdapter = await this.runnerAdapterFactory.create(runner)
      await runnerAdapter.updateNetworkSettings(
        warmPoolBox.id,
        createBoxDto.networkBlockAll,
        createBoxDto.networkAllowList,
        organization.boxLimitedNetworkEgress,
      )
    }

    const updatedBox = await this.boxRepository.update(warmPoolBox.id, {
      updateData,
      entity: warmPoolBox,
    })

    // Defensive invalidation of orgId cache since the box moved from unassigned to a real organization
    this.boxLookupCacheInvalidationService.invalidateOrgId({
      boxId: warmPoolBox.id,
      organizationId: organization.id,
      name: warmPoolBox.name,
      previousOrganizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
    })

    // Treat this as a newly started box
    this.eventEmitter.emit(
      BoxEvents.STATE_UPDATED,
      new BoxStateUpdatedEvent(updatedBox, BoxState.STARTED, BoxState.STARTED),
    )
    return this.toBoxDto(updatedBox)
  }

  async createFromBuildInfo(createBoxDto: CreateBoxDto, organization: Organization): Promise<BoxDto> {
    let pendingCpuIncrement: number | undefined
    let pendingMemoryIncrement: number | undefined
    let pendingDiskIncrement: number | undefined

    const region = await this.getValidatedOrDefaultRegion(organization, createBoxDto.target)

    try {
      const boxClass = this.getValidatedOrDefaultClass(createBoxDto.class)

      const cpu = createBoxDto.cpu || DEFAULT_CPU
      const mem = createBoxDto.memory || DEFAULT_MEMORY
      const disk = createBoxDto.disk || DEFAULT_DISK
      const gpu = createBoxDto.gpu || DEFAULT_GPU

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const { pendingCpuIncremented, pendingMemoryIncremented, pendingDiskIncremented } =
        await this.validateOrganizationQuotas(organization, region, cpu, mem, disk)

      if (pendingCpuIncremented) {
        pendingCpuIncrement = cpu
      }
      if (pendingMemoryIncremented) {
        pendingMemoryIncrement = mem
      }
      if (pendingDiskIncremented) {
        pendingDiskIncrement = disk
      }

      if (createBoxDto.volumes && createBoxDto.volumes.length > 0) {
        const volumeIdOrNames = createBoxDto.volumes.map((v) => v.volumeId)
        await this.volumeService.validateVolumes(organization.id, volumeIdOrNames)
      }

      const box = new Box(region.id, createBoxDto.name)

      box.organizationId = organization.id

      box.class = boxClass
      box.osUser = createBoxDto.user || 'boxlite'
      box.env = createBoxDto.env || {}
      box.labels = createBoxDto.labels || {}

      box.cpu = cpu
      box.gpu = gpu
      box.mem = mem
      box.disk = disk
      box.public = createBoxDto.public || false

      if (createBoxDto.networkBlockAll !== undefined) {
        box.networkBlockAll = createBoxDto.networkBlockAll
      }

      if (createBoxDto.networkAllowList !== undefined) {
        box.networkAllowList = this.resolveNetworkAllowList(createBoxDto.networkAllowList)
      }

      if (createBoxDto.autoStopInterval !== undefined) {
        box.autoStopInterval = this.resolveAutoStopInterval(createBoxDto.autoStopInterval)
      }

      if (createBoxDto.autoArchiveInterval !== undefined) {
        box.autoArchiveInterval = this.resolveAutoArchiveInterval(createBoxDto.autoArchiveInterval)
      }

      if (createBoxDto.autoDeleteInterval !== undefined) {
        box.autoDeleteInterval = createBoxDto.autoDeleteInterval
      }

      if (createBoxDto.volumes !== undefined) {
        box.volumes = this.resolveVolumes(createBoxDto.volumes)
      }

      const buildInfoSnapshotRef = generateBuildSnapshotRef(
        createBoxDto.buildInfo.dockerfileContent,
        createBoxDto.buildInfo.contextHashes,
      )

      // Check if buildInfo with the same snapshotRef already exists
      const existingBuildInfo = await this.buildInfoRepository.findOne({
        where: { snapshotRef: buildInfoSnapshotRef },
      })

      if (existingBuildInfo) {
        box.buildInfo = existingBuildInfo
        if (await this.redisLockProvider.lock(`build-info:${existingBuildInfo.snapshotRef}:update`, 60)) {
          await this.buildInfoRepository.update(box.buildInfo.snapshotRef, { lastUsedAt: new Date() })
        }
      } else {
        const buildInfoEntity = this.buildInfoRepository.create({
          ...createBoxDto.buildInfo,
        })
        await this.buildInfoRepository.save(buildInfoEntity)
        box.buildInfo = buildInfoEntity
      }

      let runner: Runner

      try {
        const declarativeBuildScoreThreshold = this.configService.get('runnerScore.thresholds.declarativeBuild')
        runner = await this.runnerService.getRandomAvailableRunner({
          regions: [box.region],
          boxClass: box.class,
          snapshotRef: box.buildInfo.snapshotRef,
          ...(declarativeBuildScoreThreshold !== undefined && {
            availabilityScoreThreshold: declarativeBuildScoreThreshold,
          }),
        })
        box.runnerId = runner.id
      } catch (error) {
        if (error instanceof BadRequestError == false || error.message !== 'No available runners' || !box.buildInfo) {
          throw error
        }
        box.state = BoxState.PENDING_BUILD
      }

      box.pending = true

      const insertedBox = await this.boxRepository.insert(box)

      this.eventEmitter
        .emitAsync(BoxEvents.CREATED, new BoxCreatedEvent(insertedBox))
        .catch((err) => this.logger.error('Failed to emit BoxCreatedEvent', err))

      return this.toBoxDto(insertedBox)
    } catch (error) {
      await this.rollbackPendingUsage(
        organization.id,
        region.id,
        pendingCpuIncrement,
        pendingMemoryIncrement,
        pendingDiskIncrement,
      )

      if (error.code === '23505') {
        throw new ConflictException(`Box with name ${createBoxDto.name} already exists`)
      }

      throw error
    }
  }

  async createBackup(boxIdOrName: string, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    if (box.autoDeleteInterval === 0) {
      throw new BoxError('Ephemeral boxes cannot be backed up')
    }

    if (![BackupState.COMPLETED, BackupState.NONE].includes(box.backupState)) {
      throw new BoxError('Box backup is already in progress')
    }

    this.eventEmitter.emit(BoxEvents.BACKUP_CREATED, new BoxBackupCreatedEvent(box))

    return box
  }

  async findAllDeprecated(
    organizationId: string,
    labels?: { [key: string]: string },
    includeErroredDestroyed?: boolean,
  ): Promise<Box[]> {
    const baseFindOptions: FindOptionsWhere<Box> = {
      organizationId,
      ...(labels ? { labels: JsonContains(labels) } : {}),
    }

    const where: FindOptionsWhere<Box>[] = [
      {
        ...baseFindOptions,
        state: Not(In([BoxState.DESTROYED, BoxState.ERROR, BoxState.BUILD_FAILED])),
      },
      {
        ...baseFindOptions,
        state: In([BoxState.ERROR, BoxState.BUILD_FAILED]),
        ...(includeErroredDestroyed ? {} : { desiredState: Not(BoxDesiredState.DESTROYED) }),
      },
    ]

    return this.boxRepository.find({ where })
  }

  async findAll(
    organizationId: string,
    page = 1,
    limit = 10,
    filters?: {
      id?: string
      name?: string
      labels?: { [key: string]: string }
      includeErroredDestroyed?: boolean
      states?: BoxState[]
      snapshots?: string[]
      regionIds?: string[]
      minCpu?: number
      maxCpu?: number
      minMemoryGiB?: number
      maxMemoryGiB?: number
      minDiskGiB?: number
      maxDiskGiB?: number
      lastEventAfter?: Date
      lastEventBefore?: Date
    },
    sort?: {
      field?: BoxSortField
      direction?: BoxSortDirection
    },
  ): Promise<PaginatedList<Box>> {
    const pageNum = Number(page)
    const limitNum = Number(limit)

    const {
      id,
      name,
      labels,
      includeErroredDestroyed,
      states,
      snapshots,
      regionIds,
      minCpu,
      maxCpu,
      minMemoryGiB,
      maxMemoryGiB,
      minDiskGiB,
      maxDiskGiB,
      lastEventAfter,
      lastEventBefore,
    } = filters || {}

    const { field: sortField = DEFAULT_BOX_SORT_FIELD, direction: sortDirection = DEFAULT_BOX_SORT_DIRECTION } =
      sort || {}

    const baseFindOptions: FindOptionsWhere<Box> = {
      organizationId,
      ...(id ? { id: ILike(`${id}%`) } : {}),
      ...(name ? { name: ILike(`${name}%`) } : {}),
      ...(labels ? { labels: JsonContains(labels) } : {}),
      ...(snapshots ? { snapshot: In(snapshots) } : {}),
      ...(regionIds ? { region: In(regionIds) } : {}),
    }

    baseFindOptions.cpu = createRangeFilter(minCpu, maxCpu)
    baseFindOptions.mem = createRangeFilter(minMemoryGiB, maxMemoryGiB)
    baseFindOptions.disk = createRangeFilter(minDiskGiB, maxDiskGiB)
    baseFindOptions.updatedAt = createRangeFilter(lastEventAfter, lastEventBefore)

    const statesToInclude = (states || Object.values(BoxState)).filter((state) => state !== BoxState.DESTROYED)
    const errorStates = [BoxState.ERROR, BoxState.BUILD_FAILED]

    const nonErrorStatesToInclude = statesToInclude.filter((state) => !errorStates.includes(state))
    const errorStatesToInclude = statesToInclude.filter((state) => errorStates.includes(state))

    const where: FindOptionsWhere<Box>[] = []

    if (nonErrorStatesToInclude.length > 0) {
      where.push({
        ...baseFindOptions,
        state: In(nonErrorStatesToInclude),
      })
    }

    if (errorStatesToInclude.length > 0) {
      where.push({
        ...baseFindOptions,
        state: In(errorStatesToInclude),
        ...(includeErroredDestroyed ? {} : { desiredState: Not(BoxDesiredState.DESTROYED) }),
      })
    }

    const [items, total] = await this.boxRepository.findAndCount({
      where,
      order: {
        [sortField]: {
          direction: sortDirection,
          nulls: 'LAST',
        },
        ...(sortField !== BoxSortField.CREATED_AT && { createdAt: 'DESC' }),
      },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    })

    return {
      items,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    }
  }

  private getExpectedDesiredStateForState(state: BoxState): BoxDesiredState | undefined {
    switch (state) {
      case BoxState.STARTED:
        return BoxDesiredState.STARTED
      case BoxState.STOPPED:
        return BoxDesiredState.STOPPED
      case BoxState.ARCHIVED:
        return BoxDesiredState.ARCHIVED
      case BoxState.DESTROYED:
        return BoxDesiredState.DESTROYED
      default:
        return undefined
    }
  }

  private hasValidDesiredState(state: BoxState): boolean {
    return this.getExpectedDesiredStateForState(state) !== undefined
  }

  async findByRunnerId(runnerId: string, states?: BoxState[], skipReconcilingBoxes?: boolean): Promise<Box[]> {
    const where: FindOptionsWhere<Box> = { runnerId }
    if (states && states.length > 0) {
      // Validate that all states have corresponding desired states
      states.forEach((state) => {
        if (!this.hasValidDesiredState(state)) {
          throw new BadRequestError(`State ${state} does not have a corresponding desired state`)
        }
      })
      where.state = In(states)
    }

    let boxes = await this.boxRepository.find({ where })

    if (skipReconcilingBoxes) {
      boxes = boxes.filter((box) => {
        const expectedDesiredState = this.getExpectedDesiredStateForState(box.state)
        return expectedDesiredState !== undefined && expectedDesiredState === box.desiredState
      })
    }

    return boxes
  }

  async findOneByIdOrName(boxIdOrName: string, organizationId: string, returnDestroyed?: boolean): Promise<Box> {
    const stateFilter = returnDestroyed ? {} : { state: Not(BoxState.DESTROYED) }
    const relations: ['buildInfo'] = ['buildInfo']

    // Try lookup by ID first
    let box = await this.boxRepository.findOne({
      where: {
        id: boxIdOrName,
        organizationId,
        ...stateFilter,
      },
      relations,
      cache: {
        id: boxLookupCacheKeyById({ organizationId, returnDestroyed, boxId: boxIdOrName }),
        milliseconds: BOX_LOOKUP_CACHE_TTL_MS,
      },
    })

    // Fallback to lookup by name
    if (!box) {
      box = await this.boxRepository.findOne({
        where: {
          name: boxIdOrName,
          organizationId,
          ...stateFilter,
        },
        relations,
        cache: {
          id: boxLookupCacheKeyByName({ organizationId, returnDestroyed, boxName: boxIdOrName }),
          milliseconds: BOX_LOOKUP_CACHE_TTL_MS,
        },
      })
    }

    if (
      !box ||
      (!returnDestroyed &&
        [BoxState.ERROR, BoxState.BUILD_FAILED].includes(box.state) &&
        box.desiredState === BoxDesiredState.DESTROYED)
    ) {
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }

    return box
  }

  async findOne(boxId: string, returnDestroyed?: boolean): Promise<Box> {
    const box = await this.boxRepository.findOne({
      where: {
        id: boxId,
        ...(returnDestroyed ? {} : { state: Not(BoxState.DESTROYED) }),
      },
    })

    if (
      !box ||
      (!returnDestroyed &&
        [BoxState.ERROR, BoxState.BUILD_FAILED].includes(box.state) &&
        box.desiredState === BoxDesiredState.DESTROYED)
    ) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    return box
  }

  async getOrganizationId(boxIdOrName: string, organizationId?: string): Promise<string> {
    let box = await this.boxRepository.findOne({
      where: {
        id: boxIdOrName,
        ...(organizationId ? { organizationId: organizationId } : {}),
      },
      select: ['organizationId'],
      cache: {
        id: boxOrgIdCacheKeyById({ organizationId, boxId: boxIdOrName }),
        milliseconds: BOX_ORG_ID_CACHE_TTL_MS,
      },
    })

    if (!box && organizationId) {
      box = await this.boxRepository.findOne({
        where: {
          name: boxIdOrName,
          organizationId: organizationId,
        },
        select: ['organizationId'],
        cache: {
          id: boxOrgIdCacheKeyByName({ organizationId, boxName: boxIdOrName }),
          milliseconds: BOX_ORG_ID_CACHE_TTL_MS,
        },
      })
    }

    if (!box || !box.organizationId) {
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }

    return box.organizationId
  }

  async getRunnerId(boxId: string): Promise<string | null> {
    const box = await this.boxRepository.findOne({
      where: {
        id: boxId,
      },
      select: ['runnerId'],
      loadEagerRelations: false,
    })

    if (!box) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    return box.runnerId || null
  }

  async getRegionId(boxId: string): Promise<string> {
    const box = await this.boxRepository.findOne({
      where: {
        id: boxId,
      },
      select: ['region'],
      loadEagerRelations: false,
    })

    if (!box) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    return box.region
  }

  async getPortPreviewUrl(boxIdOrName: string, organizationId: string, port: number): Promise<PortPreviewUrlDto> {
    if (port < 1 || port > 65535) {
      throw new BadRequestError('Invalid port')
    }

    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    const proxyProtocol = this.configService.getOrThrow('proxy.protocol')

    const where: FindOptionsWhere<Box> = {
      organizationId: organizationId,
      state: Not(BoxState.DESTROYED),
    }

    const box = await this.boxRepository.findOne({
      where: [
        {
          id: boxIdOrName,
          ...where,
        },
        {
          name: boxIdOrName,
          ...where,
        },
      ],
      cache: {
        id: `box:${boxIdOrName}:organization:${organizationId}`,
        milliseconds: 1000,
      },
    })

    if (!box) {
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }

    let url = `${proxyProtocol}://${port}-${box.id}.${proxyDomain}`

    const region = await this.regionService.findOne(box.region, true)
    if (region && region.proxyUrl) {
      // Insert port and box.id into the custom proxy URL
      url = region.proxyUrl.replace(/(https?:\/)(\/)/, `$1/${port}-${box.id}.`)
    }

    return {
      boxId: box.id,
      url,
      token: box.authToken,
    }
  }

  async getSignedPortPreviewUrl(
    boxIdOrName: string,
    organizationId: string,
    port: number,
    expiresInSeconds = 60,
  ): Promise<SignedPortPreviewUrlDto> {
    if (port < 1 || port > 65535) {
      throw new BadRequestError('Invalid port')
    }

    if (expiresInSeconds < 1 || expiresInSeconds > 60 * 60 * 24) {
      throw new BadRequestError('expiresInSeconds must be between 1 second and 24 hours')
    }

    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    const proxyProtocol = this.configService.getOrThrow('proxy.protocol')

    const where: FindOptionsWhere<Box> = {
      organizationId: organizationId,
      state: Not(BoxState.DESTROYED),
    }

    const box = await this.boxRepository.findOne({
      where: [
        {
          id: boxIdOrName,
          ...where,
        },
        {
          name: boxIdOrName,
          ...where,
        },
      ],
      cache: {
        id: `box:${boxIdOrName}:organization:${organizationId}`,
        milliseconds: 1000,
      },
    })

    if (!box) {
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }

    const token = customNanoid(urlAlphabet.replace('_', '').replace('-', ''))(16).toLocaleLowerCase()

    const lockKey = `box:signed-preview-url-token:${port}:${token}`
    await this.redis.setex(lockKey, expiresInSeconds, box.id)

    let url = `${proxyProtocol}://${port}-${token}.${proxyDomain}`

    const region = await this.regionService.findOne(box.region, true)
    if (region && region.proxyUrl) {
      // Insert port and box.id into the custom proxy URL
      url = region.proxyUrl.replace(/(https?:\/)(\/)/, `$1/${port}-${token}.`)
    }

    return {
      boxId: box.id,
      port,
      token,
      url,
    }
  }

  async getBoxIdFromSignedPreviewUrlToken(token: string, port: number): Promise<string> {
    const lockKey = `box:signed-preview-url-token:${port}:${token}`
    const boxId = await this.redis.get(lockKey)
    if (!boxId) {
      throw new ForbiddenException('Invalid or expired token')
    }
    return boxId
  }

  async expireSignedPreviewUrlToken(
    boxIdOrName: string,
    organizationId: string,
    token: string,
    port: number,
  ): Promise<void> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)
    if (!box) {
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }

    const lockKey = `box:signed-preview-url-token:${port}:${token}`
    await this.redis.del(lockKey)
  }

  async destroy(boxIdOrName: string, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    if (box.pending && box.state !== BoxState.PENDING_BUILD) {
      throw new BoxError('Box state change in progress')
    }

    const updateData = Box.getSoftDeleteUpdate(box)

    const updatedBox = await this.boxRepository.updateWhere(box.id, {
      updateData,
      whereCondition: { pending: box.pending, state: box.state },
    })

    this.eventEmitter.emit(BoxEvents.DESTROYED, new BoxDestroyedEvent(updatedBox))
    return updatedBox
  }

  async start(boxIdOrName: string, organization: Organization): Promise<Box> {
    let pendingCpuIncrement: number | undefined
    let pendingMemoryIncrement: number | undefined
    let pendingDiskIncrement: number | undefined

    const box = await this.findOneByIdOrName(boxIdOrName, organization.id)

    const region = await this.regionService.findOne(box.region)
    if (!region) {
      throw new NotFoundException(`Region with ID ${box.region} not found`)
    }

    try {
      if (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) {
        return box
      }

      this.assertBoxNotErrored(box)

      if (String(box.state) !== String(box.desiredState)) {
        // Allow start of stopped | archived and archiving | archived boxes
        if (
          box.desiredState !== BoxDesiredState.ARCHIVED ||
          (box.state !== BoxState.STOPPED && box.state !== BoxState.ARCHIVING)
        ) {
          throw new BoxError('State change in progress')
        }
      }

      if (![BoxState.STOPPED, BoxState.ARCHIVED, BoxState.ARCHIVING].includes(box.state)) {
        throw new BoxError('Box is not in valid state')
      }

      if (box.pending) {
        throw new BoxError('Box state change in progress')
      }

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      const { pendingCpuIncremented, pendingMemoryIncremented, pendingDiskIncremented } =
        await this.validateOrganizationQuotas(organization, region, box.cpu, box.mem, box.disk, box.id)

      if (pendingCpuIncremented) {
        pendingCpuIncrement = box.cpu
      }
      if (pendingMemoryIncremented) {
        pendingMemoryIncrement = box.mem
      }
      if (pendingDiskIncremented) {
        pendingDiskIncrement = box.disk
      }

      const updateData: Partial<Box> = {
        pending: true,
        desiredState: BoxDesiredState.STARTED,
        authToken: nanoid(32).toLocaleLowerCase(),
      }

      const updatedBox = await this.boxRepository.updateWhere(box.id, {
        updateData,
        whereCondition: { pending: false, state: box.state },
      })

      this.eventEmitter.emit(BoxEvents.STARTED, new BoxStartedEvent(updatedBox))

      return updatedBox
    } catch (error) {
      await this.rollbackPendingUsage(
        organization.id,
        box.region,
        pendingCpuIncrement,
        pendingMemoryIncrement,
        pendingDiskIncrement,
      )
      throw error
    }
  }

  async stop(boxIdOrName: string, organizationId?: string, force?: boolean): Promise<Box> {
    // Capture the JS call stack so we can identify the code path that hit
    // boxService.stop() — the audit log only records the leaf endpoint,
    // not which internal mechanism (cron / event handler / sync loop) routed
    // here. Frames below the BoxService entry are the interesting ones.
    const stack = new Error().stack?.split('\n').slice(2, 8).join(' | ') || '<no stack>'
    this.logger.warn(
      `[stop-trace] box=${boxIdOrName} organizationId=${organizationId ?? 'undefined'} force=${force ?? false} caller=${stack}`,
    )

    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    this.assertBoxNotErrored(box)

    if (String(box.state) !== String(box.desiredState)) {
      throw new BoxError('State change in progress')
    }

    if (box.state !== BoxState.STARTED) {
      throw new BoxError('Box is not started')
    }

    if (box.pending) {
      throw new BoxError('Box state change in progress')
    }

    const updateData: Partial<Box> = {
      pending: true,
      desiredState: box.autoDeleteInterval === 0 ? BoxDesiredState.DESTROYED : BoxDesiredState.STOPPED,
    }

    const updatedBox = await this.boxRepository.updateWhere(box.id, {
      updateData,
      whereCondition: { pending: false, state: box.state },
    })

    this.logger.warn(
      `[stop-trace] box=${box.id} desiredState set to ${updateData.desiredState} (autoDeleteInterval=${box.autoDeleteInterval})`,
    )

    if (box.autoDeleteInterval === 0) {
      this.eventEmitter.emit(BoxEvents.DESTROYED, new BoxDestroyedEvent(updatedBox))
    } else {
      this.eventEmitter.emit(BoxEvents.STOPPED, new BoxStoppedEvent(updatedBox, force))
    }

    return updatedBox
  }

  async recover(boxIdOrName: string, organization: Organization): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organization.id)

    if (box.state !== BoxState.ERROR) {
      throw new BadRequestError('Box must be in error state to recover')
    }

    if (box.pending) {
      throw new BoxError('Box state change in progress')
    }

    // Validate runner exists
    if (!box.runnerId) {
      throw new NotFoundException(`Box with ID ${box.id} does not have a runner`)
    }
    const runner = await this.runnerService.findOneOrFail(box.runnerId)

    if (runner.apiVersion === '2') {
      // TODO: we need "recovering" state that can be set after calling recover
      // Once in recovering, we abort further processing and let the manager/job handler take care of it
      // (Also, since desiredState would be STARTED, we need to check the quota)
      throw new ForbiddenException('Recovering boxes with runner API version 2 is not supported')
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      await runnerAdapter.recoverBox(box)
    } catch (error) {
      if (error instanceof Error && error.message.includes('storage cannot be further expanded')) {
        const errorMsg = `Box storage cannot be further expanded. Maximum expansion of ${(box.disk * 0.1).toFixed(2)}GB (10% of original ${box.disk.toFixed(2)}GB) has been reached. Please contact support for further assistance.`
        throw new ForbiddenException(errorMsg)
      }
      throw error
    }

    const updateData: Partial<Box> = {
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      errorReason: null,
      recoverable: false,
    }

    await this.boxRepository.updateWhere(box.id, {
      updateData,
      whereCondition: { state: BoxState.ERROR },
    })

    // Now that box is in STOPPED state, use the normal start flow
    // This handles quota validation, pending usage, event emission, etc.
    return await this.start(box.id, organization)
  }

  async resize(boxIdOrName: string, resizeDto: ResizeBoxDto, organization: Organization): Promise<Box> {
    let pendingCpuIncrement: number | undefined
    let pendingMemoryIncrement: number | undefined
    let pendingDiskIncrement: number | undefined

    const box = await this.findOneByIdOrName(boxIdOrName, organization.id)

    const region = await this.regionService.findOne(box.region)
    if (!region) {
      throw new NotFoundException(`Region with ID ${box.region} not found`)
    }

    try {
      // Validate box is in a valid state for resize
      if (box.state !== BoxState.STARTED && box.state !== BoxState.STOPPED) {
        throw new BadRequestError('Box must be in started or stopped state to resize')
      }

      if (box.pending) {
        throw new BoxError('Box state change in progress')
      }

      // If no resize parameters provided, throw error
      if (resizeDto.cpu === undefined && resizeDto.memory === undefined && resizeDto.disk === undefined) {
        throw new BadRequestError('No resource changes specified - box is already at the desired configuration')
      }

      // Disk resize requires stopped box (cold resize only)
      if (resizeDto.disk !== undefined && box.state !== BoxState.STOPPED) {
        throw new BadRequestError('Disk resize can only be performed on a stopped box')
      }

      // Hot resize (box is running): only CPU and memory can be increased
      const isHotResize = box.state === BoxState.STARTED

      // Validate hot resize constraints
      if (isHotResize) {
        if (resizeDto.cpu !== undefined && resizeDto.cpu < box.cpu) {
          throw new BadRequestError('Box must be in stopped state to decrease the number of CPU cores')
        }

        if (resizeDto.memory !== undefined && resizeDto.memory < box.mem) {
          throw new BadRequestError('Box must be in stopped state to decrease memory')
        }
      }

      // Disk can only be increased (never decreased)
      if (resizeDto.disk !== undefined && resizeDto.disk < box.disk) {
        throw new BadRequestError('Box disk size cannot be decreased')
      }

      // Calculate new resource values
      const newCpu = resizeDto.cpu ?? box.cpu
      const newMem = resizeDto.memory ?? box.mem
      const newDisk = resizeDto.disk ?? box.disk

      // Throw if nothing actually changes
      if (newCpu === box.cpu && newMem === box.mem && newDisk === box.disk) {
        throw new BadRequestError('No resource changes specified - box is already at the desired configuration')
      }

      // Validate organization quotas for the new resource values
      this.organizationService.assertOrganizationIsNotSuspended(organization)

      // Validate per-box quotas with total new values
      if (newCpu > organization.maxCpuPerBox) {
        throw new ForbiddenException(
          `CPU request ${newCpu} exceeds maximum allowed per box (${organization.maxCpuPerBox}).\n${PER_BOX_LIMIT_MESSAGE}`,
        )
      }
      if (newMem > organization.maxMemoryPerBox) {
        throw new ForbiddenException(
          `Memory request ${newMem}GB exceeds maximum allowed per box (${organization.maxMemoryPerBox}GB).\n${PER_BOX_LIMIT_MESSAGE}`,
        )
      }
      if (newDisk > organization.maxDiskPerBox) {
        throw new ForbiddenException(
          `Disk request ${newDisk}GB exceeds maximum allowed per box (${organization.maxDiskPerBox}GB).\n${PER_BOX_LIMIT_MESSAGE}`,
        )
      }

      // For cold resize, cpu/memory don't affect quota until box is STARTED.
      // For hot resize, track all deltas (positive reserves quota, negative frees quota for others).
      const cpuDeltaForQuota = isHotResize ? newCpu - box.cpu : 0
      const memDeltaForQuota = isHotResize ? newMem - box.mem : 0
      const diskDeltaForQuota = newDisk - box.disk // Disk only increases (validated at start of method)

      // Validate and track pending for any non-zero quota changes
      if (cpuDeltaForQuota !== 0 || memDeltaForQuota !== 0 || diskDeltaForQuota !== 0) {
        const { pendingCpuIncremented, pendingMemoryIncremented, pendingDiskIncremented } =
          await this.validateOrganizationQuotas(
            organization,
            region,
            cpuDeltaForQuota,
            memDeltaForQuota,
            diskDeltaForQuota,
          )

        if (pendingCpuIncremented) {
          pendingCpuIncrement = cpuDeltaForQuota
        }
        if (pendingMemoryIncremented) {
          pendingMemoryIncrement = memDeltaForQuota
        }
        if (pendingDiskIncremented) {
          pendingDiskIncrement = diskDeltaForQuota
        }
      }

      // Get runner and validate before changing state
      if (!box.runnerId) {
        throw new BadRequestError('Box has no runner assigned')
      }

      const runner = await this.runnerService.findOneOrFail(box.runnerId)

      // Capture the previous state before transitioning to RESIZING (STARTED or STOPPED)
      const previousState =
        box.state === BoxState.STARTED ? BoxState.STARTED : box.state === BoxState.STOPPED ? BoxState.STOPPED : null

      if (!previousState) {
        throw new BadRequestError('Box must be in started or stopped state to resize')
      }

      // Now transition to RESIZING state
      const updateData: Partial<Box> = {
        state: BoxState.RESIZING,
      }

      await this.boxRepository.updateWhere(box.id, {
        updateData,
        whereCondition: { pending: false, state: previousState },
      })

      try {
        const runnerAdapter = await this.runnerAdapterFactory.create(runner)

        await runnerAdapter.resizeBox(box.id, resizeDto.cpu, resizeDto.memory, resizeDto.disk)

        // For V0 runners, update resources immediately (subscriber emits STATE_UPDATED)
        // For V2 runners, job handler will update resources on completion
        if (runner.apiVersion === '0') {
          const updateData: Partial<Box> = {
            cpu: newCpu,
            mem: newMem,
            disk: newDisk,
            state: previousState,
          }

          await this.boxRepository.updateWhere(box.id, {
            updateData,
            whereCondition: { state: BoxState.RESIZING },
          })

          // Apply the usage change (increments current, decrements pending)
          // Only apply deltas for quotas that were validated/pending-incremented
          await this.organizationUsageService.applyResizeUsageChange(
            organization.id,
            box.region,
            cpuDeltaForQuota,
            memDeltaForQuota,
            diskDeltaForQuota,
          )
        }

        return await this.findOneByIdOrName(box.id, organization.id)
      } catch (error) {
        // Return to previous state on error
        const updateData: Partial<Box> = {
          state: previousState,
        }

        await this.boxRepository.updateWhere(box.id, {
          updateData,
          whereCondition: { state: BoxState.RESIZING },
        })

        throw error
      }
    } catch (error) {
      await this.rollbackPendingUsage(
        organization.id,
        box.region,
        pendingCpuIncrement,
        pendingMemoryIncrement,
        pendingDiskIncrement,
      )
      throw error
    }
  }

  async updatePublicStatus(boxIdOrName: string, isPublic: boolean, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    const updateData: Partial<Box> = {
      public: isPublic,
    }

    return await this.boxRepository.update(box.id, {
      updateData,
      entity: box,
    })
  }

  async updateLastActivityAt(boxId: string, lastActivityAt: Date): Promise<void> {
    await this.boxActivityService.updateLastActivityAt(boxId, lastActivityAt)
  }

  async getToolboxProxyUrl(boxId: string): Promise<string> {
    const box = await this.findOne(boxId)
    return this.resolveToolboxProxyUrl(box.region)
  }

  async toBoxDto(box: Box): Promise<BoxDto> {
    const toolboxProxyUrl = await this.resolveToolboxProxyUrl(box.region)
    return BoxDto.fromBox(box, toolboxProxyUrl)
  }

  async toBoxDtos(boxes: Box[]): Promise<BoxDto[]> {
    const urlMap = await this.resolveToolboxProxyUrls(boxes.map((s) => s.region))
    return boxes.map((s) => {
      const url = urlMap.get(s.region)
      if (!url) {
        throw new NotFoundException(`Toolbox proxy URL not resolved for region ${s.region}`)
      }
      return BoxDto.fromBox(s, url)
    })
  }

  async resolveToolboxProxyUrl(regionId: string): Promise<string> {
    const cacheKey = toolboxProxyUrlCacheKey(regionId)
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return cached
    }

    const region = await this.regionService.findOne(regionId)
    const url = region?.toolboxProxyUrl
      ? region.toolboxProxyUrl.replace(/\/+$/, '') + '/toolbox'
      : this.configService.getOrThrow('proxy.toolboxUrl')

    this.redis.setex(cacheKey, TOOLBOX_PROXY_URL_CACHE_TTL_S, url).catch((err) => {
      this.logger.warn(`Failed to cache toolbox proxy URL for region ${regionId}: ${err.message}`)
    })
    return url
  }

  async resolveToolboxProxyUrls(regionIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(regionIds)]
    const result = new Map<string, string>()

    const pipeline = this.redis.pipeline()
    for (const id of unique) {
      pipeline.get(toolboxProxyUrlCacheKey(id))
    }
    const cached = await pipeline.exec()

    const uncached: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const err = cached?.[i]?.[0]
      if (err) {
        this.logger.warn(`Failed to get cached toolbox proxy URL for region ${unique[i]}: ${err.message}`)
      }
      const val = cached?.[i]?.[1] as string | null
      if (val) {
        result.set(unique[i], val)
      } else {
        uncached.push(unique[i])
      }
    }

    if (uncached.length > 0) {
      const regions = await this.regionService.findByIds(uncached)
      const regionMap = new Map(regions.map((r) => [r.id, r]))
      const fallback = this.configService.getOrThrow('proxy.toolboxUrl')
      const setPipeline = this.redis.pipeline()
      for (const id of uncached) {
        const region = regionMap.get(id)
        const url = region?.toolboxProxyUrl ? region.toolboxProxyUrl.replace(/\/+$/, '') + '/toolbox' : fallback
        result.set(id, url)
        setPipeline.setex(toolboxProxyUrlCacheKey(id), TOOLBOX_PROXY_URL_CACHE_TTL_S, url)
      }
      const setResults = await setPipeline.exec()
      setResults?.forEach(([err], i) => {
        if (err) {
          this.logger.warn(`Failed to cache toolbox proxy URL for region ${uncached[i]}: ${err.message}`)
        }
      })
    }

    return result
  }

  async getBuildLogsUrl(boxIdOrName: string, organizationId: string): Promise<string> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    if (!box.buildInfo?.snapshotRef) {
      throw new NotFoundException(`Box ${boxIdOrName} has no build info`)
    }

    const region = await this.regionService.findOne(box.region, true)

    if (!region) {
      throw new NotFoundException(`Region for runner for box ${boxIdOrName} not found`)
    }

    if (!region.proxyUrl) {
      return `${this.configService.getOrThrow('proxy.protocol')}://${this.configService.getOrThrow('proxy.domain')}/boxes/${box.id}/build-logs`
    }

    return region.proxyUrl + '/boxes/' + box.id + '/build-logs'
  }

  private async getValidatedOrDefaultRegion(organization: Organization, regionIdOrName?: string): Promise<Region> {
    if (!organization.defaultRegionId) {
      throw new DefaultRegionRequiredException()
    }

    regionIdOrName = regionIdOrName?.trim()

    if (!regionIdOrName) {
      const region = await this.regionService.findOne(organization.defaultRegionId)
      if (!region) {
        throw new NotFoundException('Default region not found')
      }
      return region
    }

    const region =
      (await this.regionService.findOneByName(regionIdOrName, organization.id)) ??
      (await this.regionService.findOneByName(regionIdOrName, null)) ??
      (await this.regionService.findOne(regionIdOrName))

    if (!region) {
      throw new NotFoundException('Region not found')
    }

    return region
  }

  private getValidatedOrDefaultClass(boxClass: BoxClass): BoxClass {
    if (!boxClass) {
      return BoxClass.SMALL
    }

    if (Object.values(BoxClass).includes(boxClass)) {
      return boxClass
    } else {
      throw new BadRequestError('Invalid class')
    }
  }

  async replaceLabels(boxIdOrName: string, labels: { [key: string]: string }, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    // Replace all labels
    const updateData: Partial<Box> = {
      labels,
    }

    return await this.boxRepository.update(box.id, { updateData, entity: box })
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'cleanup-destroyed-boxes' })
  @LogExecution('cleanup-destroyed-boxes')
  @WithInstrumentation()
  async cleanupDestroyedBoxes() {
    const twentyFourHoursAgo = new Date()
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24)

    const destroyedBoxs = await this.boxRepository.delete({
      state: BoxState.DESTROYED,
      updatedAt: LessThan(twentyFourHoursAgo),
    })

    if (destroyedBoxs.affected > 0) {
      this.logger.debug(`Cleaned up ${destroyedBoxs.affected} destroyed boxes`)
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'cleanup-build-failed-boxes' })
  @LogExecution('cleanup-build-failed-boxes')
  @WithInstrumentation()
  async cleanupBuildFailedBoxes() {
    const twentyFourHoursAgo = new Date()
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24)

    const destroyedBoxs = await this.boxRepository.delete({
      state: BoxState.BUILD_FAILED,
      desiredState: BoxDesiredState.DESTROYED,
      updatedAt: LessThan(twentyFourHoursAgo),
    })

    if (destroyedBoxs.affected > 0) {
      this.logger.debug(`Cleaned up ${destroyedBoxs.affected} build failed boxes`)
    }
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'cleanup-stale-build-failed-boxes' })
  @LogExecution('cleanup-stale-build-failed-boxes')
  @WithInstrumentation()
  async cleanupStaleBuildFailedBoxes() {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const result = await this.boxRepository.delete({
      state: BoxState.BUILD_FAILED,
      desiredState: BoxDesiredState.STARTED,
      updatedAt: LessThan(sevenDaysAgo),
    })

    if (result.affected > 0) {
      this.logger.debug(`Cleaned up ${result.affected} stale build failed boxes`)
    }
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'cleanup-stale-error-boxes' })
  @LogExecution('cleanup-stale-error-boxes')
  @WithInstrumentation()
  async cleanupStaleErrorBoxes() {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const result = await this.boxRepository.delete({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.DESTROYED,
      updatedAt: LessThan(sevenDaysAgo),
    })

    if (result.affected > 0) {
      this.logger.debug(`Cleaned up ${result.affected} stale error boxes`)
    }
  }

  async setAutostopInterval(boxIdOrName: string, interval: number, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    const updateData: Partial<Box> = {
      autoStopInterval: this.resolveAutoStopInterval(interval),
    }

    return await this.boxRepository.update(box.id, { updateData, entity: box })
  }

  async setAutoArchiveInterval(boxIdOrName: string, interval: number, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    const updateData: Partial<Box> = {
      autoArchiveInterval: this.resolveAutoArchiveInterval(interval),
    }

    return await this.boxRepository.update(box.id, { updateData, entity: box })
  }

  async setAutoDeleteInterval(boxIdOrName: string, interval: number, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    const updateData: Partial<Box> = {
      autoDeleteInterval: interval,
    }

    return await this.boxRepository.update(box.id, { updateData, entity: box })
  }

  async updateNetworkSettings(
    boxIdOrName: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    organizationId?: string,
  ): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    const updateData: Partial<Box> = {}

    if (networkBlockAll !== undefined) {
      updateData.networkBlockAll = networkBlockAll
    }

    if (networkAllowList !== undefined) {
      updateData.networkAllowList = this.resolveNetworkAllowList(networkAllowList)
    }

    const updatedBox = await this.boxRepository.update(box.id, { updateData, entity: box })

    // Update network settings on the runner
    if (box.runnerId) {
      const runner = await this.runnerService.findOne(box.runnerId)
      if (runner) {
        const runnerAdapter = await this.runnerAdapterFactory.create(runner)
        await runnerAdapter.updateNetworkSettings(box.id, networkBlockAll, networkAllowList)
      }
    }

    return updatedBox
  }

  // used by internal services to update the state of a box to resolve domain and runner state mismatch
  // notably, when a box instance stops or errors on the runner, the domain state needs to be updated to reflect the actual state
  async updateState(boxId: string, newState: BoxState, recoverable = false, errorReason?: string): Promise<void> {
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })

    if (!box) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    if (box.state === newState) {
      this.logger.debug(`Box ${boxId} is already in state ${newState}`)
      return
    }

    //  only allow updating the state of started | stopped boxes
    if (![BoxState.STARTED, BoxState.STOPPED].includes(box.state)) {
      throw new BadRequestError('Box is not in a valid state to be updated')
    }

    if (box.desiredState == BoxDesiredState.DESTROYED) {
      this.logger.debug(`Box ${boxId} is already DESTROYED, skipping state update`)
      return
    }

    const oldState = box.state
    const oldDesiredState = box.desiredState

    const updateData: Partial<Box> = {
      state: newState,
      recoverable: false,
    }

    if (errorReason !== undefined) {
      updateData.errorReason = errorReason
      if (newState === BoxState.ERROR) {
        updateData.recoverable = recoverable
      }
    }

    //  we need to update the desired state to match the new state
    const desiredState = this.getExpectedDesiredStateForState(newState)
    if (desiredState) {
      updateData.desiredState = desiredState
    }

    await this.boxRepository.updateWhere(box.id, {
      updateData,
      whereCondition: { pending: false, state: oldState, desiredState: oldDesiredState },
    })
  }

  @OnEvent(WarmPoolEvents.TOPUP_REQUESTED)
  private async createWarmPoolBox(event: WarmPoolTopUpRequested) {
    await this.createForWarmPool(event.warmPool)
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'handle-unschedulable-runners' })
  @LogExecution('handle-unschedulable-runners')
  @WithInstrumentation()
  private async handleUnschedulableRunners() {
    const runners = await this.runnerRepository.find({ where: { unschedulable: true } })

    if (runners.length === 0) {
      return
    }

    //  find all boxes that are using the unschedulable runners and have organizationId = '00000000-0000-0000-0000-000000000000'
    const boxes = await this.boxRepository.find({
      where: {
        runnerId: In(runners.map((runner) => runner.id)),
        organizationId: '00000000-0000-0000-0000-000000000000',
        state: BoxState.STARTED,
        desiredState: Not(BoxDesiredState.DESTROYED),
      },
    })

    if (boxes.length === 0) {
      return
    }

    const destroyPromises = boxes.map((box) => this.destroy(box.id))
    const results = await Promise.allSettled(destroyPromises)

    // Log any failed box destructions
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(`Failed to destroy box ${boxes[index].id}: ${result.reason}`)
      }
    })
  }

  async isBoxPublic(boxId: string): Promise<boolean> {
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })

    if (!box) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    return box.public
  }

  @OnEvent(OrganizationEvents.SUSPENDED_BOX_STOPPED)
  async handleSuspendedBoxStopped(event: OrganizationSuspendedBoxStoppedEvent) {
    await this.stop(event.boxId).catch((error) => {
      //  log the error for now, but don't throw it as it will be retried
      this.logger.error(`Error stopping box from suspended organization. BoxId: ${event.boxId}: `, error)
    })
  }

  private resolveAutoStopInterval(autoStopInterval: number): number {
    if (autoStopInterval < 0) {
      throw new BadRequestError('Auto-stop interval must be non-negative')
    }

    return autoStopInterval
  }

  private resolveAutoArchiveInterval(autoArchiveInterval: number): number {
    if (autoArchiveInterval < 0) {
      throw new BadRequestError('Auto-archive interval must be non-negative')
    }

    const maxAutoArchiveInterval = this.configService.getOrThrow('maxAutoArchiveInterval')

    if (autoArchiveInterval === 0) {
      return maxAutoArchiveInterval
    }

    return Math.min(autoArchiveInterval, maxAutoArchiveInterval)
  }

  private resolveNetworkAllowList(networkAllowList: string): string {
    try {
      validateNetworkAllowList(networkAllowList)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Invalid network allow list')
    }

    return networkAllowList
  }

  private resolveVolumes(volumes: BoxVolume[]): BoxVolume[] {
    try {
      validateMountPaths(volumes)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Invalid volume mount configuration')
    }

    try {
      validateSubpaths(volumes)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : 'Invalid volume subpath configuration')
    }

    return volumes
  }

  async createSshAccess(boxIdOrName: string, expiresInMinutes = 60, organizationId?: string): Promise<SshAccessDto> {
    //  check if box exists
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    // Revoke any existing SSH access for this box
    await this.revokeSshAccess(box.id)

    const sshAccess = new SshAccess()
    sshAccess.boxId = box.id
    // Generate a safe token that can't doesn't have _ or - to avoid CLI issues
    sshAccess.token = customNanoid(urlAlphabet.replace('_', '').replace('-', ''))(32)
    sshAccess.expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000)

    await this.sshAccessRepository.save(sshAccess)

    const region = await this.regionService.findOne(box.region, true)
    if (region && region.sshGatewayUrl) {
      return SshAccessDto.fromSshAccess(sshAccess, region.sshGatewayUrl)
    }

    return SshAccessDto.fromSshAccess(sshAccess, this.configService.getOrThrow('sshGateway.url'))
  }

  async revokeSshAccess(boxIdOrName: string, token?: string, organizationId?: string): Promise<Box> {
    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

    if (token) {
      // Revoke specific SSH access by token
      await this.sshAccessRepository.delete({ boxId: box.id, token })
    } else {
      // Revoke all SSH access for the box
      await this.sshAccessRepository.delete({ boxId: box.id })
    }

    return box
  }

  async validateSshAccess(token: string): Promise<SshAccessValidationDto> {
    const sshAccess = await this.sshAccessRepository.findOne({
      where: {
        token,
      },
      relations: ['box'],
    })

    if (!sshAccess) {
      return { valid: false, boxId: null }
    }

    // Check if token is expired
    const isExpired = sshAccess.expiresAt < new Date()
    if (isExpired) {
      return { valid: false, boxId: null }
    }

    // Get runner information if box exists
    if (sshAccess.box && sshAccess.box.runnerId) {
      const runner = await this.runnerService.findOne(sshAccess.box.runnerId)

      if (runner) {
        return {
          valid: true,
          boxId: sshAccess.box.id,
        }
      }
    }

    return { valid: true, boxId: sshAccess.box.id }
  }

  async updateBoxBackupState(
    boxId: string,
    backupState: BackupState,
    backupSnapshot?: string | null,
    backupRegistryId?: string | null,
    backupErrorReason?: string | null,
  ): Promise<void> {
    const boxToUpdate = await this.boxRepository.findOneByOrFail({
      id: boxId,
    })

    const updateData = Box.getBackupStateUpdate(
      boxToUpdate,
      backupState,
      backupSnapshot,
      backupRegistryId,
      backupErrorReason,
    )

    await this.boxRepository.update(boxId, { updateData, entity: boxToUpdate })
  }
}
