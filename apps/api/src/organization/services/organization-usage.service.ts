/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { Organization } from '../entities/organization.entity'
import { OrganizationQuota } from '../entities/organization-quota.entity'
import { BOX_STATES_CONSUMING_COMPUTE, BOX_STATES_CONSUMING_DISK } from '../constants/box-consuming-states.constant'
import { assertWithinOrgQuota, DEFAULT_ORG_QUOTA, OrgQuotaLimits, OrgResourceUsage } from './org-quota'
import { boxUsageContribution, stateTransitionDelta } from './box-usage'

/** The five metered dimensions. `count` is the concurrent-running-box limit. */
type QuotaResource = 'cpu' | 'memory' | 'disk' | 'gpu' | 'count'

/** Fixed order used to line up Redis keys with their script arguments. */
const PENDING_RESOURCES: QuotaResource[] = ['cpu', 'memory', 'disk', 'gpu', 'count']

/** Which dimensions a reservation actually incremented, so the caller can roll back exactly those. */
export interface PendingBoxReservation {
  cpu: number
  memory: number
  disk: number
  gpu: number
  count: number
}

interface BoxUsageOverview extends OrgResourceUsage {
  pendingCpu: number
  pendingMemory: number
  pendingDisk: number
  pendingGpu: number
  pendingCount: number
}

/**
 * Tracks and enforces per-organization box quotas: summed cpu / memory / disk / gpu
 * across a tenant's running boxes, plus a cap on the number of concurrently running
 * boxes. Current usage is derived from the box table (cached in Redis, kept fresh by
 * box lifecycle events); a short-lived Redis "pending" reservation is added before a
 * box is persisted so two concurrent creates cannot both slip past the same headroom.
 */
@Injectable()
export class OrganizationUsageService {
  private readonly logger = new Logger(OrganizationUsageService.name)

  /** Time-to-live for cached usage values, and for pending reservations (so a create
   * that dies before the box is persisted cannot leak a reservation forever). */
  private readonly CACHE_TTL_SECONDS = 60

  /** Cached current usage is force-refreshed from the database once older than this. */
  private readonly CACHE_MAX_AGE_MS = 60 * 60 * 1000

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(Box) private readonly boxRepository: Repository<Box>,
    @InjectRepository(OrganizationQuota) private readonly quotaRepository: Repository<OrganizationQuota>,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  /** The organization's quota limits, or the built-in defaults when it has no row. */
  async getQuotaLimits(organizationId: string): Promise<OrgQuotaLimits> {
    const quota = await this.quotaRepository.findOne({ where: { organizationId } })
    return quota ?? DEFAULT_ORG_QUOTA
  }

  /**
   * Reserve headroom for a box and reject if it would exceed any organization ceiling.
   *
   * The reservation is written to Redis before the box row exists, closing the
   * check-then-create race. On any violation the reservation is rolled back and a
   * 400 is thrown; on success the caller must either let the box's CREATED/
   * STATE_UPDATED event realize the reservation into current usage, or call
   * {@link rollbackPendingUsage} if the surrounding operation fails.
   *
   * @param excludeBoxId omit the box's own current contribution (used by start, where
   *   the box already exists in a non-consuming state) so it is not double counted.
   */
  async validateOrganizationQuotas(
    organization: Organization,
    cpu: number,
    memory: number,
    disk: number,
    gpu: number,
    excludeBoxId?: string,
  ): Promise<PendingBoxReservation> {
    const reservation = await this.incrementPendingBoxUsage(organization.id, cpu, memory, disk, gpu)

    try {
      const limits = await this.getQuotaLimits(organization.id)
      const overview = await this.getBoxUsageOverview(organization.id, excludeBoxId)
      const projected: OrgResourceUsage = {
        cpu: overview.cpu + overview.pendingCpu,
        memory: overview.memory + overview.pendingMemory,
        disk: overview.disk + overview.pendingDisk,
        gpu: overview.gpu + overview.pendingGpu,
        count: overview.count + overview.pendingCount,
      }
      assertWithinOrgQuota(limits, projected, gpu)
    } catch (error) {
      await this.rollbackPendingUsage(organization.id, reservation)
      throw error
    }

    return reservation
  }

  /**
   * Release a reservation made by {@link validateOrganizationQuotas} when the box was
   * not (or no longer) realized — e.g. the create failed after reserving. Best-effort:
   * a failure here is logged, and the reservation's TTL is the final backstop.
   */
  async rollbackPendingUsage(organizationId: string, reservation: PendingBoxReservation): Promise<void> {
    if (
      !reservation.cpu &&
      !reservation.memory &&
      !reservation.disk &&
      !reservation.gpu &&
      !reservation.count
    ) {
      return
    }

    try {
      await this.decrementPendingBoxUsage(organizationId, reservation)
    } catch (error) {
      this.logger.error(`Error rolling back pending box usage for organization ${organizationId}: ${error}`)
    }
  }

  /** Current usage (cached, less any excluded box) plus outstanding pending reservations. */
  async getBoxUsageOverview(organizationId: string, excludeBoxId?: string): Promise<BoxUsageOverview> {
    const cached = await this.getCachedBoxUsage(organizationId)
    if (cached) {
      return excludeBoxId ? await this.excludeBoxFromUsage(cached, excludeBoxId) : cached
    }

    const lockKey = `org:${organizationId}:fetch-box-usage`
    await this.redisLockProvider.waitForLock(lockKey, 60)
    try {
      const recheck = await this.getCachedBoxUsage(organizationId)
      if (recheck) {
        return excludeBoxId ? await this.excludeBoxFromUsage(recheck, excludeBoxId) : recheck
      }

      const current = await this.fetchBoxUsageFromDb(organizationId)
      const pending = await this.getCachedPendingUsage(organizationId)
      const overview: BoxUsageOverview = { ...current, ...pending }
      return excludeBoxId ? await this.excludeBoxFromUsage(overview, excludeBoxId) : overview
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private async excludeBoxFromUsage(overview: BoxUsageOverview, excludeBoxId: string): Promise<BoxUsageOverview> {
    const box = await this.boxRepository.findOne({ where: { id: excludeBoxId } })
    if (!box) {
      return overview
    }

    const contribution = boxUsageContribution(box)
    return {
      ...overview,
      cpu: Math.max(0, overview.cpu - contribution.cpu),
      memory: Math.max(0, overview.memory - contribution.memory),
      disk: Math.max(0, overview.disk - contribution.disk),
      gpu: Math.max(0, overview.gpu - contribution.gpu),
      count: Math.max(0, overview.count - contribution.count),
    }
  }

  private async getCachedBoxUsage(organizationId: string): Promise<BoxUsageOverview | null> {
    // Read all ten keys (five current + five pending) in one script so current
    // and pending come from a single consistent snapshot.
    const script = `
      local out = {}
      for i = 1, #KEYS do
        out[i] = redis.call("GET", KEYS[i])
      end
      return out
    `
    const currentKeys = PENDING_RESOURCES.map((resource) => this.currentKey(organizationId, resource))
    const pendingKeys = PENDING_RESOURCES.map((resource) => this.pendingKey(organizationId, resource))
    const values = (await this.redis.eval(
      script,
      currentKeys.length + pendingKeys.length,
      ...currentKeys,
      ...pendingKeys,
    )) as (string | null)[]

    const currentValues = values.slice(0, PENDING_RESOURCES.length)
    const pendingValues = values.slice(PENDING_RESOURCES.length)

    // Any missing current dimension is a cache miss — fall back to the database.
    if (currentValues.some((v) => v === null)) {
      return null
    }
    if (await this.isCacheStale(organizationId)) {
      return null
    }

    const current = this.parseUsage(currentValues)
    if (!current) {
      return null
    }

    const [cpu, memory, disk, gpu, count] = pendingValues.map((v) => this.parseNonNegative(v) ?? 0)
    return { ...current, pendingCpu: cpu, pendingMemory: memory, pendingDisk: disk, pendingGpu: gpu, pendingCount: count }
  }

  private async getCachedPendingUsage(
    organizationId: string,
  ): Promise<Pick<BoxUsageOverview, 'pendingCpu' | 'pendingMemory' | 'pendingDisk' | 'pendingGpu' | 'pendingCount'>> {
    const keys: QuotaResource[] = ['cpu', 'memory', 'disk', 'gpu', 'count']
    const values = await this.redis.mget(...keys.map((k) => this.pendingKey(organizationId, k)))
    const [cpu, memory, disk, gpu, count] = values.map((v) => this.parseNonNegative(v) ?? 0)
    return { pendingCpu: cpu, pendingMemory: memory, pendingDisk: disk, pendingGpu: gpu, pendingCount: count }
  }

  private async fetchBoxUsageFromDb(organizationId: string): Promise<OrgResourceUsage> {
    const computePredicate = 'box.state IN (:...computeStates)'

    const raw = await this.boxRepository
      .createQueryBuilder('box')
      .select(`SUM(CASE WHEN ${computePredicate} THEN box.cpu ELSE 0 END)`, 'used_cpu')
      .addSelect(`SUM(CASE WHEN ${computePredicate} THEN box.mem ELSE 0 END)`, 'used_memory')
      .addSelect('SUM(CASE WHEN box.state IN (:...diskStates) THEN box.disk ELSE 0 END)', 'used_disk')
      .addSelect(`SUM(CASE WHEN ${computePredicate} THEN box.gpu ELSE 0 END)`, 'used_gpu')
      .addSelect(`SUM(CASE WHEN ${computePredicate} THEN 1 ELSE 0 END)`, 'used_count')
      .where('box."organizationId" = :organizationId', { organizationId })
      .setParameter('computeStates', BOX_STATES_CONSUMING_COMPUTE)
      .setParameter('diskStates', BOX_STATES_CONSUMING_DISK)
      .getRawOne<{
        used_cpu: string | null
        used_memory: string | null
        used_disk: string | null
        used_gpu: string | null
        used_count: string | null
      }>()

    const usage: OrgResourceUsage = {
      cpu: Number(raw?.used_cpu ?? 0),
      memory: Number(raw?.used_memory ?? 0),
      disk: Number(raw?.used_disk ?? 0),
      gpu: Number(raw?.used_gpu ?? 0),
      count: Number(raw?.used_count ?? 0),
    }

    const pipeline = this.redis.pipeline()
    pipeline.setex(this.currentKey(organizationId, 'cpu'), this.CACHE_TTL_SECONDS, usage.cpu)
    pipeline.setex(this.currentKey(organizationId, 'memory'), this.CACHE_TTL_SECONDS, usage.memory)
    pipeline.setex(this.currentKey(organizationId, 'disk'), this.CACHE_TTL_SECONDS, usage.disk)
    pipeline.setex(this.currentKey(organizationId, 'gpu'), this.CACHE_TTL_SECONDS, usage.gpu)
    pipeline.setex(this.currentKey(organizationId, 'count'), this.CACHE_TTL_SECONDS, usage.count)
    await pipeline.exec()
    await this.resetCacheStaleness(organizationId)

    return usage
  }

  private async incrementPendingBoxUsage(
    organizationId: string,
    cpu: number,
    memory: number,
    disk: number,
    gpu: number,
  ): Promise<PendingBoxReservation> {
    // Reserve the box's full target contribution. When the caller passes an
    // excludeBoxId, getBoxUsageOverview subtracts the box's *current* contribution,
    // so reserving the full amount here counts the box exactly once — including its
    // disk when starting an already-stopped box (whose disk is already in current).
    // Dimensions unchanged by the transition (e.g. disk on start) drain via the
    // pending TTL rather than a state-change event.
    const reservation: PendingBoxReservation = { cpu, memory, disk, gpu, count: 1 }
    await this.reservePending(organizationId, reservation)
    return reservation
  }

  /**
   * Atomically add a reservation to the pending counters (skipping zero dimensions)
   * and refresh their TTL, so a concurrent reader never sees a partially-applied
   * reservation across the five keys. ARGV = [amounts…, ttl].
   */
  private async reservePending(organizationId: string, reservation: PendingBoxReservation): Promise<void> {
    const script = `
      local ttl = tonumber(ARGV[#KEYS + 1])
      for i = 1, #KEYS do
        local amount = tonumber(ARGV[i])
        if amount > 0 then
          redis.call("INCRBY", KEYS[i], amount)
          redis.call("EXPIRE", KEYS[i], ttl)
        end
      end
    `
    const keys = PENDING_RESOURCES.map((resource) => this.pendingKey(organizationId, resource))
    await this.redis.eval(
      script,
      keys.length,
      ...keys,
      ...PENDING_RESOURCES.map((resource) => reservation[resource].toString()),
      this.CACHE_TTL_SECONDS.toString(),
    )
  }

  private async decrementPendingBoxUsage(
    organizationId: string,
    reservation: PendingBoxReservation,
  ): Promise<void> {
    const script = `
      for i = 1, #KEYS do
        local amount = tonumber(ARGV[i])
        if amount > 0 then
          redis.call("DECRBY", KEYS[i], amount)
        end
      end
    `
    const keys = PENDING_RESOURCES.map((resource) => this.pendingKey(organizationId, resource))
    await this.redis.eval(
      script,
      keys.length,
      ...keys,
      ...PENDING_RESOURCES.map((resource) => reservation[resource].toString()),
    )
  }

  /**
   * Move `delta` of a resource from pending into current usage. Only mutates the
   * current cache when it already exists (otherwise the next database re-sum picks the
   * change up), and only draws down pending on positive deltas (a box entering a
   * consuming state realizes its reservation; leaving one just lowers current usage).
   */
  private async updateCurrentQuotaUsage(
    organizationId: string,
    resource: QuotaResource,
    delta: number,
  ): Promise<void> {
    if (delta === 0) {
      return
    }

    const script = `
      local currentKey = KEYS[1]
      local pendingKey = KEYS[2]
      local delta = tonumber(ARGV[1])
      local ttl = tonumber(ARGV[2])

      if redis.call("EXISTS", currentKey) == 1 then
        redis.call("INCRBY", currentKey, delta)
        redis.call("EXPIRE", currentKey, ttl)
      end

      local pending = tonumber(redis.call("GET", pendingKey))
      if pending and pending > 0 and delta > 0 then
        local drawdown = math.min(pending, delta)
        redis.call("DECRBY", pendingKey, drawdown)
      end
    `

    await this.redis.eval(
      script,
      2,
      this.currentKey(organizationId, resource),
      this.pendingKey(organizationId, resource),
      delta.toString(),
      this.CACHE_TTL_SECONDS.toString(),
    )
  }

  @OnEvent(BoxEvents.CREATED)
  async handleBoxCreated(event: BoxCreatedEvent): Promise<void> {
    const box = event.box
    const lockKey = `box:${box.id}:quota-usage-update`
    await this.redisLockProvider.waitForLock(lockKey, 60)
    try {
      await this.updateCurrentQuotaUsage(box.organizationId, 'cpu', box.cpu)
      await this.updateCurrentQuotaUsage(box.organizationId, 'memory', box.mem)
      await this.updateCurrentQuotaUsage(box.organizationId, 'disk', box.disk)
      await this.updateCurrentQuotaUsage(box.organizationId, 'gpu', box.gpu)
      await this.updateCurrentQuotaUsage(box.organizationId, 'count', 1)
    } catch (error) {
      this.logger.warn(`Error updating cached box quota usage for organization ${box.organizationId}: ${error}`)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent): Promise<void> {
    const box = event.box
    const lockKey = `box:${box.id}:quota-usage-update`
    await this.redisLockProvider.waitForLock(lockKey, 60)
    try {
      // Warm-pool assignment re-emits STARTED -> STARTED to attribute an already
      // running box to its new organization; the membership deltas would be zero.
      if (event.oldState === event.newState && event.newState === BoxState.STARTED) {
        await this.updateCurrentQuotaUsage(box.organizationId, 'cpu', box.cpu)
        await this.updateCurrentQuotaUsage(box.organizationId, 'memory', box.mem)
        await this.updateCurrentQuotaUsage(box.organizationId, 'disk', box.disk)
        await this.updateCurrentQuotaUsage(box.organizationId, 'gpu', box.gpu)
        await this.updateCurrentQuotaUsage(box.organizationId, 'count', 1)
        return
      }

      const cpuDelta = stateTransitionDelta(box.cpu, event.oldState, event.newState, BOX_STATES_CONSUMING_COMPUTE)
      const memoryDelta = stateTransitionDelta(box.mem, event.oldState, event.newState, BOX_STATES_CONSUMING_COMPUTE)
      const diskDelta = stateTransitionDelta(box.disk, event.oldState, event.newState, BOX_STATES_CONSUMING_DISK)
      const gpuDelta = stateTransitionDelta(box.gpu, event.oldState, event.newState, BOX_STATES_CONSUMING_COMPUTE)
      const countDelta = stateTransitionDelta(1, event.oldState, event.newState, BOX_STATES_CONSUMING_COMPUTE)

      await this.updateCurrentQuotaUsage(box.organizationId, 'cpu', cpuDelta)
      await this.updateCurrentQuotaUsage(box.organizationId, 'memory', memoryDelta)
      await this.updateCurrentQuotaUsage(box.organizationId, 'disk', diskDelta)
      await this.updateCurrentQuotaUsage(box.organizationId, 'gpu', gpuDelta)
      await this.updateCurrentQuotaUsage(box.organizationId, 'count', countDelta)
    } catch (error) {
      this.logger.warn(`Error updating cached box quota usage for organization ${box.organizationId}: ${error}`)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private currentKey(organizationId: string, resource: QuotaResource): string {
    return `quota:current:${organizationId}:${resource}`
  }

  private pendingKey(organizationId: string, resource: QuotaResource): string {
    return `quota:pending:${organizationId}:${resource}`
  }

  private stalenessKey(organizationId: string): string {
    return `quota:current:${organizationId}:populated-at`
  }

  private async resetCacheStaleness(organizationId: string): Promise<void> {
    await this.redis.set(this.stalenessKey(organizationId), Date.now().toString())
  }

  private async isCacheStale(organizationId: string): Promise<boolean> {
    const populatedAt = await this.redis.get(this.stalenessKey(organizationId))
    if (populatedAt === null) {
      return true
    }
    const age = Date.now() - Number(populatedAt)
    return Number.isNaN(age) || age > this.CACHE_MAX_AGE_MS
  }

  private parseUsage(values: (string | null)[]): OrgResourceUsage | null {
    const [cpu, memory, disk, gpu, count] = values.map((v) => this.parseNonNegative(v))
    if (cpu === null || memory === null || disk === null || gpu === null || count === null) {
      return null
    }
    return { cpu, memory, disk, gpu, count }
  }

  private parseNonNegative(value: string | null): number | null {
    if (value === null) {
      return null
    }
    const parsed = Number(value)
    if (Number.isNaN(parsed) || parsed < 0) {
      return null
    }
    return parsed
  }
}
