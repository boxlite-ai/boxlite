/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { Cron, CronExpression } from '@nestjs/schedule'
import { Redis } from 'ioredis'
import { DataSource, EntityManager, In, Not } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxEvents } from '../constants/box-events.constants'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxCreationAdmissionUnavailableError, BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxConflictError } from '../errors/box-conflict.error'
import { BOX_CREATION_LIMIT_EXCLUDED_STATES } from '../repositories/box.repository'

const ACQUIRE = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('DEL', KEYS[3])
  return {-1, 0}
end
local existingCount = tonumber(redis.call('GET', KEYS[1]))
if existingCount > 0 and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[3])
  return {-1, 0}
end
if redis.call('HEXISTS', KEYS[2], ARGV[2]) == 1 then
  return {2, existingCount}
end
local current = redis.call('INCR', KEYS[1])
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return {0, current - 1}
end
redis.call('HSET', KEYS[2], ARGV[2], 'reserved:' .. ARGV[3])
return {1, current}`

const RELEASE = `
local removed = redis.call('HDEL', KEYS[2], ARGV[1])
if removed == 1 and redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0`

const TRACK_ACTIVE = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('DEL', KEYS[3])
  return -1
end
local current = tonumber(redis.call('GET', KEYS[1]))
if current > 0 and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[3])
  return -1
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  redis.call('HSET', KEYS[2], ARGV[1], 'active')
  return 0
end
redis.call('HSET', KEYS[2], ARGV[1], 'active')
redis.call('INCR', KEYS[1])
return 1`

const ENSURE_ACTIVE = `
for _, boxId in ipairs(ARGV) do
  if redis.call('HEXISTS', KEYS[2], boxId) == 1 then
    redis.call('HSET', KEYS[2], boxId, 'active')
  else
    redis.call('HSET', KEYS[2], boxId, 'active')
    redis.call('INCR', KEYS[1])
  end
end
return 0`

const BEGIN_RECONCILIATION = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('DEL', KEYS[3])
else
  local current = tonumber(redis.call('GET', KEYS[1]))
  if current > 0 and redis.call('EXISTS', KEYS[2]) == 0 then
    redis.call('DEL', KEYS[3])
  end
end
redis.call('SET', KEYS[1], '0', 'NX')
return 0`

const FINISH_RECONCILIATION = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[3])
  return -1
end
local size = redis.call('HLEN', KEYS[2])
redis.call('SET', KEYS[1], size)
redis.call('SET', KEYS[3], '1')
return size`

const RESERVATION_GRACE_MS = 5 * 60 * 1000
const RECONCILE_BATCH_SIZE = 200
const excludedStates = new Set<BoxState>(BOX_CREATION_LIMIT_EXCLUDED_STATES)

type AdmissionResult = [status: number, count: number]
type QuotaKeys = { count: string; boxes: string; ready: string }

@Injectable()
export class BoxCreationQuotaService {
  private readonly logger = new Logger(BoxCreationQuotaService.name)
  private readonly dirtyOrganizations = new Set<string>()
  private readonly reconciliations = new Map<string, Promise<void>>()

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly configService: TypedConfigService,
  ) {}

  get enabled(): boolean {
    return this.configService.get('boxCreationQuota.redisEnabled') === true
  }

  async run(
    organizationId: string,
    boxId: string,
    limit: number,
    persist: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    let admission = await this.acquire(organizationId, boxId, limit)
    if (admission[0] === -1) {
      try {
        await this.reconcileShared(organizationId)
      } catch (error) {
        this.dirtyOrganizations.add(organizationId)
        this.logger.warn(`Box creation quota initialization failed for ${organizationId}: ${this.errorMessage(error)}`)
        throw new BoxCreationAdmissionUnavailableError('Box creation quota initialization failed', 5)
      }
      admission = await this.acquire(organizationId, boxId, limit)
    }
    if (admission[0] === -1) {
      throw new BoxCreationAdmissionUnavailableError('Box creation quota is not initialized', 5)
    }
    if (admission[0] === 2) {
      throw new BoxConflictError()
    }
    if (admission[0] === 0) {
      throw new BoxCreationLimitExceededError(admission[1], limit)
    }

    let persistCompleted = false
    try {
      await this.dataSource.transaction(async (manager) => {
        await persist(manager)
        persistCompleted = true
      })
    } catch (error) {
      if (persistCompleted) {
        this.dirtyOrganizations.add(organizationId)
      } else {
        await this.releaseAfterFailure(organizationId, boxId)
      }
      throw error
    }
  }

  async trackCommitted(organizationId: string, boxId: string): Promise<void> {
    if (!this.enabled || organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) return
    const keys = this.keys(organizationId)
    try {
      const tracked = (await this.redis.eval(TRACK_ACTIVE, 3, keys.count, keys.boxes, keys.ready, boxId)) as number
      if (tracked === -1) this.dirtyOrganizations.add(organizationId)
    } catch (error) {
      this.dirtyOrganizations.add(organizationId)
      this.logger.warn(`Failed to track committed Box ${boxId} in Redis quota: ${this.errorMessage(error)}`)
    }
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent): Promise<void> {
    if (!this.enabled || event.box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) return
    const wasCounted = !excludedStates.has(event.oldState)
    const isCounted = !excludedStates.has(event.newState)
    if (wasCounted === isCounted) return

    try {
      if (isCounted) {
        await this.trackCommitted(event.box.organizationId, event.box.id)
      } else {
        await this.release(event.box.organizationId, event.box.id)
      }
    } catch (error) {
      this.dirtyOrganizations.add(event.box.organizationId)
      this.logger.warn(`Failed to update Redis quota for Box ${event.box.id}: ${this.errorMessage(error)}`)
    }
  }

  // POC: process-local scheduling permits replica overlap, loses work on exit,
  // and stops at zero replicas. Corrections are idempotent by Box ID. A future
  // distributed lease or dedicated worker must provide bounded recovery time.
  @Cron(CronExpression.EVERY_MINUTE, { name: 'box-creation-quota-reconciliation', waitForCompletion: true })
  async reconcileDirty(): Promise<void> {
    if (!this.enabled) return
    const organizations = new Set(this.dirtyOrganizations)
    for (const organizationId of organizations) this.dirtyOrganizations.delete(organizationId)
    try {
      for (const organizationId of await this.readyOrganizations()) organizations.add(organizationId)
    } catch (error) {
      this.logger.warn(`Failed to list initialized Redis quotas: ${this.errorMessage(error)}`)
    }
    for (const organizationId of organizations) {
      try {
        await this.reconcileShared(organizationId)
      } catch (error) {
        this.dirtyOrganizations.add(organizationId)
        this.logger.warn(`Redis quota reconciliation failed for ${organizationId}: ${this.errorMessage(error)}`)
      }
    }
  }

  async reconcileOrganization(organizationId: string): Promise<void> {
    const keys = this.keys(organizationId)
    await this.redis.eval(BEGIN_RECONCILIATION, 3, keys.count, keys.boxes, keys.ready)
    const boxRepository = this.dataSource.getRepository(Box)
    const activeBoxes = await boxRepository.find({
      where: {
        organizationId,
        state: Not(In(BOX_CREATION_LIMIT_EXCLUDED_STATES)),
      },
      select: { id: true },
      order: { id: 'ASC' },
    })
    const activeIds = new Set(activeBoxes.map((box) => box.id))
    const ids = Array.from(activeIds)
    for (let offset = 0; offset < ids.length; offset += RECONCILE_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + RECONCILE_BATCH_SIZE)
      await this.redis.eval(ENSURE_ACTIVE, 2, keys.count, keys.boxes, ...batch)
    }

    const recorded = await this.redis.hgetall(keys.boxes)
    const now = Date.now()
    for (const [boxId, value] of Object.entries(recorded)) {
      if (activeIds.has(boxId)) continue
      if (value.startsWith('reserved:')) {
        const reservedAt = Number(value.slice('reserved:'.length))
        if (Number.isFinite(reservedAt) && now - reservedAt < RESERVATION_GRACE_MS) {
          const excluded = await boxRepository.exists({
            where: {
              id: boxId,
              organizationId,
              state: In(BOX_CREATION_LIMIT_EXCLUDED_STATES),
            },
          })
          if (!excluded) continue
        }
      }
      await this.release(organizationId, boxId)
    }
    const ready = (await this.redis.eval(FINISH_RECONCILIATION, 3, keys.count, keys.boxes, keys.ready)) as number
    if (ready === -1) throw new Error('Redis quota keys disappeared during reconciliation')
  }

  private async acquire(organizationId: string, boxId: string, limit: number): Promise<AdmissionResult> {
    const keys = this.keys(organizationId)
    try {
      return (await this.redis.eval(
        ACQUIRE,
        3,
        keys.count,
        keys.boxes,
        keys.ready,
        String(limit),
        boxId,
        String(Date.now()),
      )) as AdmissionResult
    } catch (error) {
      this.logger.warn(`Redis box quota is unavailable for ${organizationId}: ${this.errorMessage(error)}`)
      throw new BoxCreationAdmissionUnavailableError('Redis box quota is unavailable', 5)
    }
  }

  private async release(organizationId: string, boxId: string): Promise<void> {
    const keys = this.keys(organizationId)
    await this.redis.eval(RELEASE, 2, keys.count, keys.boxes, boxId)
  }

  private async releaseAfterFailure(organizationId: string, boxId: string): Promise<void> {
    try {
      await this.release(organizationId, boxId)
    } catch (error) {
      this.dirtyOrganizations.add(organizationId)
      this.logger.warn(`Failed to release Redis quota for Box ${boxId}: ${this.errorMessage(error)}`)
    }
  }

  private reconcileShared(organizationId: string): Promise<void> {
    const current = this.reconciliations.get(organizationId)
    if (current) return current
    const running = this.reconcileOrganization(organizationId).finally(() => {
      this.reconciliations.delete(organizationId)
    })
    this.reconciliations.set(organizationId, running)
    return running
  }

  private async readyOrganizations(): Promise<string[]> {
    const organizations = new Set<string>()
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'box:quota:{*}:ready', 'COUNT', 200)
      cursor = next
      for (const key of keys) {
        const match = /^box:quota:\{(.+)\}:ready$/.exec(key)
        if (match) organizations.add(decodeURIComponent(match[1]))
      }
    } while (cursor !== '0')
    return Array.from(organizations)
  }

  private keys(organizationId: string): QuotaKeys {
    const prefix = `box:quota:{${encodeURIComponent(organizationId)}}`
    return { count: `${prefix}:count`, boxes: `${prefix}:boxes`, ready: `${prefix}:ready` }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
