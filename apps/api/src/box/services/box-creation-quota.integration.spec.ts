/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { EventEmitter2 } from '@nestjs/event-emitter'
import Redis from 'ioredis'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddOrganizationActivationFacts1792490000000 } from '../../migrations/pre-deploy/1792490000000-add-organization-activation-facts-migration'
import { AddBoxCreationQuotaIndex1795478400000 } from '../../migrations/pre-deploy/1795478400000-add-box-creation-quota-index-migration'
import { BoxEvents } from '../constants/box-events.constants'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxConflictError } from '../errors/box-conflict.error'
import { BoxRepository } from '../repositories/box.repository'
import { BoxCreationQuotaService } from './box-creation-quota.service'

const describeIfServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip
const schemaName = `redis_box_quota_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()

function keys(organizationId: string) {
  const prefix = `box:quota:{${encodeURIComponent(organizationId)}}`
  return { count: `${prefix}:count`, boxes: `${prefix}:boxes`, ready: `${prefix}:ready` }
}

function newBox(name: string, owner = organizationId): Box {
  const box = new Box('us', name)
  box.organizationId = owner
  box.osUser = 'boxlite'
  box.labels = {}
  box.pending = true
  return box
}

describeIfServices('Redis Box creation quota (real PostgreSQL and Redis)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let repository: BoxRepository
  let quota: BoxCreationQuotaService
  let redis: Redis
  let events: EventEmitter2
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      migrations: [AddOrganizationActivationFacts1792490000000, AddBoxCreationQuotaIndex1795478400000],
      migrationsTransactionMode: 'each',
      extra: { max: 10, options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    await dataSource.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await dataSource.query('INSERT INTO organization (id) VALUES ($1), ($2)', [organizationId, otherOrganizationId])
    await dataSource.runMigrations()
    boxes = dataSource.getRepository(Box)

    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      retryStrategy: null,
    })
    await redis.connect()
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'boxCreationQuota.redisEnabled') return true
        if (key === 'boxSync.organizationActivityAsync') return false
        return undefined
      }),
    }
    quota = new BoxCreationQuotaService(redis, dataSource, config as never)
    events = new EventEmitter2()
    events.on(BoxEvents.STATE_UPDATED, (event: BoxStateUpdatedEvent) => {
      void quota.handleBoxStateUpdated(event)
    })
    repository = new BoxRepository(
      dataSource,
      events,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
      config as never,
    )
    Object.assign(repository, { creationQuota: quota })
  }, 30_000)

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."organization_activation_facts"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    const orgKeys = [organizationId, otherOrganizationId].flatMap((id) => Object.values(keys(id)))
    await redis.del(...orgKeys)
  })

  afterAll(async () => {
    if (redis) {
      const orgKeys = [organizationId, otherOrganizationId].flatMap((id) => Object.values(keys(id)))
      if (redis.status === 'ready') await redis.del(...orgKeys)
      redis.disconnect()
    }
    if (dataSource?.isInitialized) {
      try {
        if (ownsSchema) await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      } finally {
        await dataSource.destroy()
      }
    }
  })

  async function expectRedisCount(owner: string, expected: number): Promise<void> {
    let actual: string | null = null
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      actual = await redis.get(keys(owner).count)
      if (actual === String(expected)) return
      await delay(10)
    }
    expect(actual).toBe(String(expected))
  }

  async function postgresBoxCount(): Promise<number> {
    const [row] = await dataSource.query(`SELECT count(*)::int AS count FROM "${schemaName}"."box"`)
    return row.count
  }

  it('backfills existing Boxes and never calls PostgreSQL COUNT on the Redis path', async () => {
    await boxes.insert(newBox('existing'))
    const count = jest.spyOn(EntityManager.prototype, 'count')
    try {
      await repository.insert(newBox('new'), 2)
      expect(count).not.toHaveBeenCalled()
    } finally {
      count.mockRestore()
    }

    expect(await postgresBoxCount()).toBe(2)
    expect(await dataSource.getRepository(BoxLastActivity).count()).toBe(1)
    await expectRedisCount(organizationId, 2)
    for (const key of Object.values(keys(organizationId))) expect(await redis.ttl(key)).toBe(-1)

    await expect(repository.insert(newBox('over-limit'), 2)).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(await postgresBoxCount()).toBe(2)
    await expectRedisCount(organizationId, 2)
  }, 20_000)

  it('allows exactly one of two creates competing for the final slot', async () => {
    const results = await Promise.allSettled([
      repository.insert(newBox('final-a'), 1),
      repository.insert(newBox('final-b'), 1),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBeInstanceOf(BoxCreationLimitExceededError)
    expect(await postgresBoxCount()).toBe(1)
    await expectRedisCount(organizationId, 1)
  }, 20_000)

  it('admits a same-organization burst up to the limit without contention failures', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => repository.insert(newBox(`burst-${index}`), 20)),
    )

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(await postgresBoxCount()).toBe(20)
    await expectRedisCount(organizationId, 20)
    await expect(repository.insert(newBox('one-too-many'), 20)).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(await postgresBoxCount()).toBe(20)
  }, 30_000)

  it('does not let a duplicate Box ID failure release the existing reservation', async () => {
    const original = newBox('owned-box')
    await repository.insert(original, 2)

    await expect(repository.insert(original, 2)).rejects.toBeInstanceOf(BoxConflictError)
    expect(await postgresBoxCount()).toBe(1)
    await expectRedisCount(organizationId, 1)

    await repository.insert(newBox('next-box'), 2)
    await expectRedisCount(organizationId, 2)
  }, 20_000)

  it('rebuilds a missing Box hash before admitting another create', async () => {
    await boxes.insert(newBox('existing'))
    await quota.reconcileOrganization(organizationId)
    await redis.del(keys(organizationId).boxes)
    const reconcile = jest.spyOn(quota, 'reconcileOrganization')

    try {
      await repository.insert(newBox('after-loss'), 2)
      expect(reconcile).toHaveBeenCalled()
    } finally {
      reconcile.mockRestore()
    }

    expect(await postgresBoxCount()).toBe(2)
    await expectRedisCount(organizationId, 2)
    expect(await redis.hlen(keys(organizationId).boxes)).toBe(2)
  }, 20_000)

  it('releases a failed insertion so a different name can use the reservation', async () => {
    await repository.insert(newBox('same-name'), 2)
    await expect(repository.insert(newBox('same-name'), 2)).rejects.toMatchObject({ code: '23505' })
    await expectRedisCount(organizationId, 1)

    await repository.insert(newBox('different-name'), 2)
    expect(await postgresBoxCount()).toBe(2)
    await expectRedisCount(organizationId, 2)
  }, 20_000)

  it('releases on an excluded state and counts ERROR recovery without deleting excess Boxes', async () => {
    const first = newBox('first')
    await repository.insert(first, 1)
    first.state = BoxState.ERROR
    await boxes.update(first.id, { state: BoxState.ERROR })
    events.emit(BoxEvents.STATE_UPDATED, new BoxStateUpdatedEvent(first, BoxState.STARTED, BoxState.ERROR))
    await expectRedisCount(organizationId, 0)

    await repository.insert(newBox('second'), 1)
    first.state = BoxState.STOPPED
    await boxes.update(first.id, { state: BoxState.STOPPED })
    events.emit(BoxEvents.STATE_UPDATED, new BoxStateUpdatedEvent(first, BoxState.ERROR, BoxState.STOPPED))
    await expectRedisCount(organizationId, 2)

    await expect(repository.insert(newBox('third'), 1)).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(await postgresBoxCount()).toBe(2)
  }, 20_000)

  it('reconciles missing active records, stale reservations, and counter/hash drift', async () => {
    const active = newBox('active')
    await boxes.insert(active)
    await quota.reconcileOrganization(organizationId)
    await expectRedisCount(organizationId, 1)

    await redis.hdel(keys(organizationId).boxes, active.id)
    await quota.reconcileOrganization(organizationId)
    await expectRedisCount(organizationId, 1)

    await redis.hset(keys(organizationId).boxes, 'stale-box', 'reserved:1')
    await redis.incr(keys(organizationId).count)
    await quota.reconcileOrganization(organizationId)
    await expectRedisCount(organizationId, 1)

    await redis.hset(keys(organizationId).boxes, 'recent-box', `reserved:${Date.now()}`)
    await redis.incr(keys(organizationId).count)
    await quota.reconcileOrganization(organizationId)
    await expectRedisCount(organizationId, 2)
    expect(await postgresBoxCount()).toBe(1)
  }, 20_000)

  it('keeps concurrent replica reconciliation idempotent without a distributed lease', async () => {
    await boxes.insert(Array.from({ length: 5 }, (_, index) => newBox(`replica-${index}`)))
    const otherReplica = new BoxCreationQuotaService(redis, dataSource, { get: () => true } as never)

    await Promise.all([quota.reconcileOrganization(organizationId), otherReplica.reconcileOrganization(organizationId)])

    await expectRedisCount(organizationId, 5)
    expect(await redis.hlen(keys(organizationId).boxes)).toBe(5)
  }, 20_000)

  it('repairs a completely missed state event during scheduled reconciliation', async () => {
    const active = newBox('missed-event')
    await repository.insert(active, 1)
    await boxes.update(active.id, { state: BoxState.DESTROYING })

    await quota.reconcileDirty()

    await expectRedisCount(organizationId, 0)
    expect(await postgresBoxCount()).toBe(1)
  }, 20_000)

  it('tracks an unlimited warm-pool ownership claim', async () => {
    const warm = newBox('warm', BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    warm.state = BoxState.STARTED
    warm.pending = false
    await boxes.insert(warm)

    await repository.update(warm.id, {
      updateData: { organizationId, name: 'claimed-warm' },
      entity: warm,
    })
    await quota.reconcileDirty()

    await expectRedisCount(organizationId, 1)
    expect(await postgresBoxCount()).toBe(1)
  }, 20_000)

  it('tracks an unlimited create through best-effort reconciliation', async () => {
    await repository.insert(newBox('unlimited'))
    await quota.reconcileDirty()

    await expectRedisCount(organizationId, 1)
    expect(await postgresBoxCount()).toBe(1)
  }, 20_000)

  it('isolates quota counters by organization', async () => {
    await repository.insert(newBox('first-org'), 1)
    await repository.insert(newBox('second-org', otherOrganizationId), 1)

    await expectRedisCount(organizationId, 1)
    await expectRedisCount(otherOrganizationId, 1)
    await expect(repository.insert(newBox('first-org-over'), 1)).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(await postgresBoxCount()).toBe(2)
  }, 20_000)
})
