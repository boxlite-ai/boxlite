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
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { BoxWarmPoolService } from './box-warm-pool.service'
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter'
import { WarmPoolEvents } from '../constants/warmpool-events.constants'
import { WarmPoolTopUpRequested } from '../events/warmpool-topup-requested.event'
import { Runner } from '../entities/runner.entity'
import { Organization } from '../../organization/entities/organization.entity'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import { BoxStartedEvent } from '../events/box-started.event'
import { BoxStoppedEvent } from '../events/box-stopped.event'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { OrganizationSuspendedBoxStoppedEvent } from '../../organization/events/organization-suspended-box-stopped.event'
import { TypedConfigService } from '../../config/typed-config.service'
import { WarmPool } from '../entities/warm-pool.entity'
import { BoxDto, BoxVolume } from '../dto/box.dto'
import { RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { validateNetworkAllowList } from '../utils/network-validation.util'
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
import { RedisLockProvider } from '../common/redis-lock.provider'
import { customAlphabet as customNanoid, nanoid, urlAlphabet } from 'nanoid'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { validateMountPaths, validateSubpaths } from '../utils/volume-mount-path-validation.util'
import { BoxRepository } from '../repositories/box.repository'
import { PortPreviewUrlDto, SignedPortPreviewUrlDto } from '../dto/port-preview-url.dto'
import { RegionService } from '../../region/services/region.service'
import { BoxCreatedEvent } from '../events/box-create.event'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import {
  BOX_LOOKUP_CACHE_TTL_MS,
  BOX_ORG_ID_CACHE_TTL_MS,
  TOOLBOX_PROXY_URL_CACHE_TTL_S,
  boxLookupCacheKeyByBoxId,
  boxLookupCacheKeyById,
  boxLookupCacheKeyByName,
  boxOrgIdCacheKeyByBoxId,
  boxOrgIdCacheKeyById,
  boxOrgIdCacheKeyByName,
  toolboxProxyUrlCacheKey,
} from '../utils/box-lookup-cache.util'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { Region } from '../../region/entities/region.entity'
import { BoxActivityService } from './box-activity.service'

// TODO(image-rewrite): resource defaults previously came from the removed image subsystem;
// these mirror the Box entity column defaults until image resolution is rebuilt.
const DEFAULT_BOX_CPU = 1
const DEFAULT_BOX_MEM = 1
const DEFAULT_BOX_DISK = 10
const DEFAULT_BOX_GPU = 0

@Injectable()
export class BoxService {
  private readonly logger = new Logger(BoxService.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    @InjectRepository(SshAccess)
    private readonly sshAccessRepository: Repository<SshAccess>,
    private readonly runnerService: RunnerService,
    private readonly volumeService: VolumeService,
    private readonly configService: TypedConfigService,
    private readonly warmPoolService: BoxWarmPoolService,
    private readonly eventEmitter: EventEmitter2,
    private readonly organizationService: OrganizationService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly redisLockProvider: RedisLockProvider,
    @InjectRedis() private readonly redis: Redis,
    private readonly regionService: RegionService,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
    private readonly boxActivityService: BoxActivityService,
  ) {}

  protected getLockKey(id: string): string {
    return `box:${id}:state-change`
  }

  private assertBoxNotErrored(box: Box): void {
    if (box.state === BoxState.ERROR) {
      throw new BoxError('Box is in an errored state')
    }
  }

  async createForWarmPool(warmPoolItem: WarmPool): Promise<Box> {
    const box = new Box(warmPoolItem.target)

    box.organizationId = BOX_WARM_POOL_UNASSIGNED_ORGANIZATION

    box.class = warmPoolItem.class
    box.image = warmPoolItem.image
    //  TODO: default user should be configurable
    box.osUser = 'boxlite'
    box.env = warmPoolItem.env || {}

    box.cpu = warmPoolItem.cpu
    box.gpu = warmPoolItem.gpu
    box.mem = warmPoolItem.mem
    box.disk = warmPoolItem.disk

    // TODO(image-rewrite): box image resolution removed with the image subsystem; rebuild here.
    const runner = await this.runnerService.getRandomAvailableRunner({
      regions: [box.region],
      boxClass: box.class,
    })

    box.runnerId = runner.id
    box.pending = true

    await this.boxRepository.insert(box)
    return box
  }

  async create(createBoxDto: CreateBoxDto, organization: Organization): Promise<BoxDto> {
    const region = await this.getValidatedOrDefaultRegion(organization, createBoxDto.target)

    try {
      const boxClass = this.getValidatedOrDefaultClass(createBoxDto.class)

      // TODO(image-rewrite): image resolution removed; boxes can no
      // longer resolve an image at create time. Resource sizing falls back to request values
      // (or Box entity defaults). Rebuild image resolution here.
      const cpu = createBoxDto.cpu ?? DEFAULT_BOX_CPU
      const mem = createBoxDto.memory ?? DEFAULT_BOX_MEM
      const disk = createBoxDto.disk ?? DEFAULT_BOX_DISK
      const gpu = createBoxDto.gpu ?? DEFAULT_BOX_GPU
      const image = createBoxDto.image

      this.organizationService.assertOrganizationIsNotSuspended(organization)

      if (createBoxDto.volumes && createBoxDto.volumes.length > 0) {
        const volumeIdOrNames = createBoxDto.volumes.map((v) => v.volumeId)
        await this.volumeService.validateVolumes(organization.id, volumeIdOrNames)
      } else if (image) {
        //  No volumes requested — try to claim a pre-warmed box matching this image/spec
        //  before creating a fresh one.
        const skipWarmPool = (await this.redis.exists(`warm-pool:skip:${image}`)) === 1
        if (!skipWarmPool) {
          const warmPoolBox = await this.warmPoolService.fetchWarmPoolBox({
            organizationId: organization.id,
            image,
            target: region.id,
            class: boxClass,
            cpu,
            mem,
            disk,
            gpu,
            osUser: createBoxDto.user || 'boxlite',
            env: createBoxDto.env || {},
            state: BoxState.STARTED,
          })

          if (warmPoolBox) {
            return await this.assignWarmPoolBox(warmPoolBox, createBoxDto, organization)
          }
        }
      }

      const runner = await this.runnerService.getRandomAvailableRunner({
        regions: [region.id],
        boxClass,
      })

      const box = new Box(region.id, createBoxDto.name)

      box.organizationId = organization.id

      //  TODO: make configurable
      box.class = boxClass
      //  TODO: default user should be configurable
      box.osUser = createBoxDto.user || 'boxlite'
      box.env = createBoxDto.env || {}
      box.labels = createBoxDto.labels || {}

      box.image = image
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
      id: warmPoolBox.id,
      boxId: warmPoolBox.boxId,
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
        state: Not(In([BoxState.DESTROYED, BoxState.ERROR])),
      },
      {
        ...baseFindOptions,
        state: BoxState.ERROR,
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
      ...(labels ? { labels: JsonContains(labels) } : {}),
      ...(regionIds ? { region: In(regionIds) } : {}),
    }

    baseFindOptions.cpu = createRangeFilter(minCpu, maxCpu)
    baseFindOptions.mem = createRangeFilter(minMemoryGiB, maxMemoryGiB)
    baseFindOptions.disk = createRangeFilter(minDiskGiB, maxDiskGiB)
    baseFindOptions.updatedAt = createRangeFilter(lastEventAfter, lastEventBefore)

    const statesToInclude = (states || Object.values(BoxState)).filter((state) => state !== BoxState.DESTROYED)
    const errorStates = [BoxState.ERROR]

    const nonErrorStatesToInclude = statesToInclude.filter((state) => !errorStates.includes(state))
    const errorStatesToInclude = statesToInclude.filter((state) => errorStates.includes(state))

    const where: FindOptionsWhere<Box>[] = []
    const searchFindOptions = this.getBoxSearchFindOptions(baseFindOptions, id, name)

    if (nonErrorStatesToInclude.length > 0) {
      where.push(
        ...searchFindOptions.map((findOptions) => ({
          ...findOptions,
          state: In(nonErrorStatesToInclude),
        })),
      )
    }

    if (errorStatesToInclude.length > 0) {
      where.push(
        ...searchFindOptions.map((findOptions) => ({
          ...findOptions,
          state: In(errorStatesToInclude),
          ...(includeErroredDestroyed ? {} : { desiredState: Not(BoxDesiredState.DESTROYED) }),
        })),
      )
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

  private getBoxSearchFindOptions(
    baseFindOptions: FindOptionsWhere<Box>,
    id?: string,
    name?: string,
  ): FindOptionsWhere<Box>[] {
    const nameFilter = name ? { name: ILike(`${name}%`) } : {}

    if (!id) {
      return [
        {
          ...baseFindOptions,
          ...nameFilter,
        },
      ]
    }

    const idFilter = ILike(`${id}%`)
    return [
      {
        ...baseFindOptions,
        ...nameFilter,
        boxId: idFilter,
      },
      {
        ...baseFindOptions,
        ...nameFilter,
        id: idFilter,
      },
      {
        ...baseFindOptions,
        ...nameFilter,
        name: idFilter,
      },
    ]
  }

  private getExpectedDesiredStateForState(state: BoxState): BoxDesiredState | undefined {
    switch (state) {
      case BoxState.STARTED:
        return BoxDesiredState.STARTED
      case BoxState.STOPPED:
        return BoxDesiredState.STOPPED
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

  async findOneByIdOrName(boxIdOrName: string, organizationId?: string, returnDestroyed?: boolean): Promise<Box> {
    const stateFilter = returnDestroyed ? {} : { state: Not(BoxState.DESTROYED) }
    const organizationFilter = organizationId ? { organizationId } : {}

    // Public Box ID is the user-facing stable identity. UUID and name are legacy-compatible fallbacks.
    let box = await this.boxRepository.findOne({
      where: {
        boxId: boxIdOrName,
        ...organizationFilter,
        ...stateFilter,
      },
      cache: {
        id: boxLookupCacheKeyByBoxId({ organizationId, returnDestroyed, boxId: boxIdOrName }),
        milliseconds: BOX_LOOKUP_CACHE_TTL_MS,
      },
    })

    if (!box) {
      box = await this.boxRepository.findOne({
        where: {
          id: boxIdOrName,
          ...organizationFilter,
          ...stateFilter,
        },
        cache: {
          id: boxLookupCacheKeyById({ organizationId, returnDestroyed, boxId: boxIdOrName }),
          milliseconds: BOX_LOOKUP_CACHE_TTL_MS,
        },
      })
    }

    if (!box) {
      box = await this.boxRepository.findOne({
        where: {
          name: boxIdOrName,
          ...organizationFilter,
          ...stateFilter,
        },
        cache: {
          id: boxLookupCacheKeyByName({ organizationId, returnDestroyed, boxName: boxIdOrName }),
          milliseconds: BOX_LOOKUP_CACHE_TTL_MS,
        },
      })
    }

    if (!box || (!returnDestroyed && box.state === BoxState.ERROR && box.desiredState === BoxDesiredState.DESTROYED)) {
      throw new NotFoundException(`Box with Box ID, UUID, or name ${boxIdOrName} not found`)
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

    if (!box || (!returnDestroyed && box.state === BoxState.ERROR && box.desiredState === BoxDesiredState.DESTROYED)) {
      throw new NotFoundException(`Box with ID ${boxId} not found`)
    }

    return box
  }

  async getOrganizationId(boxIdOrName: string, organizationId?: string): Promise<string> {
    const organizationFilter = organizationId ? { organizationId: organizationId } : {}

    let box = await this.boxRepository.findOne({
      where: {
        boxId: boxIdOrName,
        ...organizationFilter,
      },
      select: ['organizationId'],
      cache: {
        id: boxOrgIdCacheKeyByBoxId({ organizationId, boxId: boxIdOrName }),
        milliseconds: BOX_ORG_ID_CACHE_TTL_MS,
      },
    })

    if (!box) {
      box = await this.boxRepository.findOne({
        where: {
          id: boxIdOrName,
          ...organizationFilter,
        },
        select: ['organizationId'],
        cache: {
          id: boxOrgIdCacheKeyById({ organizationId, boxId: boxIdOrName }),
          milliseconds: BOX_ORG_ID_CACHE_TTL_MS,
        },
      })
    }

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
      throw new NotFoundException(`Box with Box ID, UUID, or name ${boxIdOrName} not found`)
    }

    return box.organizationId
  }

  async getRunnerId(boxIdOrName: string): Promise<string | null> {
    const box = await this.boxRepository.findOne({
      where: [{ boxId: boxIdOrName }, { id: boxIdOrName }, { name: boxIdOrName }],
      select: ['runnerId'],
      loadEagerRelations: false,
    })

    if (!box) {
      throw new NotFoundException(`Box with Box ID, UUID, or name ${boxIdOrName} not found`)
    }

    return box.runnerId || null
  }

  async getRegionId(boxIdOrName: string): Promise<string> {
    const box = await this.boxRepository.findOne({
      where: [{ boxId: boxIdOrName }, { id: boxIdOrName }, { name: boxIdOrName }],
      select: ['region'],
      loadEagerRelations: false,
    })

    if (!box) {
      throw new NotFoundException(`Box with Box ID, UUID, or name ${boxIdOrName} not found`)
    }

    return box.region
  }

  async getPortPreviewUrl(boxIdOrName: string, organizationId: string, port: number): Promise<PortPreviewUrlDto> {
    if (port < 1 || port > 65535) {
      throw new BadRequestError('Invalid port')
    }

    const proxyDomain = this.configService.getOrThrow('proxy.domain')
    const proxyProtocol = this.configService.getOrThrow('proxy.protocol')

    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

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

    const box = await this.findOneByIdOrName(boxIdOrName, organizationId)

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

    if (box.pending) {
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
    const box = await this.findOneByIdOrName(boxIdOrName, organization.id)

    const region = await this.regionService.findOne(box.region)
    if (!region) {
      throw new NotFoundException(`Region with ID ${box.region} not found`)
    }

    if (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) {
      return box
    }

    this.assertBoxNotErrored(box)

    if (String(box.state) !== String(box.desiredState)) {
      throw new BoxError('State change in progress')
    }

    if (box.state !== BoxState.STOPPED) {
      throw new BoxError('Box is not in valid state')
    }

    if (box.pending) {
      throw new BoxError('Box state change in progress')
    }

    this.organizationService.assertOrganizationIsNotSuspended(organization)

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
    const box = await this.findOneByIdOrName(boxIdOrName, organization.id)

    const region = await this.regionService.findOne(box.region)
    if (!region) {
      throw new NotFoundException(`Region with ID ${box.region} not found`)
    }

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

    this.organizationService.assertOrganizationIsNotSuspended(organization)

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

  private async getValidatedOrDefaultRegion(organization: Organization, regionIdOrName?: string): Promise<Region> {
    regionIdOrName = regionIdOrName?.trim()

    if (!regionIdOrName) {
      const defaultRegionId = organization.defaultRegionId || this.configService.getOrThrow('defaultRegion.id')
      const region = await this.regionService.findOne(defaultRegionId)
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
}
