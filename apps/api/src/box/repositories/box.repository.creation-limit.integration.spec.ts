/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import crypto, { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddOrganizationActivationFacts1792490000000 } from '../../migrations/pre-deploy/1792490000000-add-organization-activation-facts-migration'
import { AddBoxCreationQuotaIndex1795478400000 } from '../../migrations/pre-deploy/1795478400000-add-box-creation-quota-index-migration'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxCreationAdmissionUnavailableError, BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxRepository, CREATION_ADMISSION_LOCK_NAMESPACE } from './box.repository'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_creation_limit_${process.pid}_${randomUUID().replaceAll('-', '')}`
// Advisory locks are scoped to the database, not the test schema.
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()
const firstLaneNamespace = 0x43525000
const lastLaneNamespace = firstLaneNamespace + 7

function mockAdmissionLanes(...lanes: number[]) {
  const { randomInt } = crypto
  return jest.spyOn(crypto, 'randomInt').mockImplementation((...args: unknown[]) => {
    // Preserve other uses of crypto, including Box ID generation.
    const lane = args.length === 1 && args[0] === 8 ? lanes.shift() : undefined
    return lane ?? Reflect.apply(randomInt, crypto, args)
  })
}

function gate() {
  let open!: () => void
  const ready = new Promise<void>((resolve) => {
    open = resolve
  })
  return { ready, open }
}

async function within<T>(work: Promise<T>, message: string, ms = 2000): Promise<T> {
  const timer = new AbortController()
  try {
    return await Promise.race([
      work,
      delay(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error(message)
      }),
    ])
  } finally {
    timer.abort()
  }
}

async function admissionLocks(dataSource: DataSource) {
  return dataSource.query<Array<{ pid: number; namespace: number; mode: string; granted: boolean }>>(
    `SELECT pid, classid::int AS namespace, mode, granted FROM pg_locks
     WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND objid::bigint = (hashtext($1)::bigint & 4294967295) AND objsubid = 2
       AND (classid::bigint = $2 OR classid::bigint BETWEEN $3 AND $4)`,
    [organizationId, CREATION_ADMISSION_LOCK_NAMESPACE, firstLaneNamespace, lastLaneNamespace],
  )
}

async function waitForCompatibilityWaiter(dataSource: DataSource, mode: 'ShareLock' | 'ExclusiveLock') {
  const deadline = Date.now() + 2000
  do {
    const locks = await admissionLocks(dataSource)
    if (
      locks.some((lock) => lock.namespace === CREATION_ADMISSION_LOCK_NAMESPACE && !lock.granted && lock.mode === mode)
    ) {
      return locks
    }
    await delay(10)
  } while (Date.now() < deadline)
  throw new Error(`Did not observe a waiting ${mode} on the organization compatibility key`)
}

const excludedStates = new Set([
  BoxState.ERROR,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
  BoxState.ARCHIVING,
  BoxState.ARCHIVED,
])

function newBox(name: string, owner = organizationId): Box {
  const box = new Box('us', name)
  box.organizationId = owner
  box.osUser = 'boxlite'
  box.labels = {}
  box.pending = true
  return box
}

// Waits until another admission for the organization is queued on its advisory
// lock. Gives up after a grace period, so an admission that never queues still
// races the paused one instead of hanging the test.
async function waitForQueuedAdmission(dataSource: DataSource, owner: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const [{ waiting }] = await dataSource.query(
      `SELECT count(*)::int AS waiting FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid::bigint = $2 AND objid::bigint = (hashtext($1)::bigint & 4294967295) AND objsubid = 2`,
      [owner, CREATION_ADMISSION_LOCK_NAMESPACE],
    )
    if (waiting > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Pauses the first admission right after its count until a competing admission
// is waiting, so both compete for the final slot.
function installInitialCountBarrier(dataSource: DataSource): jest.SpyInstance {
  const transaction = dataSource.transaction.bind(dataSource)
  let paused = false

  return jest.spyOn(dataSource, 'transaction').mockImplementation(async (...args: unknown[]) => {
    if (typeof args[0] !== 'string' || typeof args[1] !== 'function') {
      return transaction(args[0] as (entityManager: EntityManager) => Promise<unknown>)
    }

    const isolation = args[0] as IsolationLevel
    const callback = args[1] as (entityManager: EntityManager) => Promise<unknown>
    return transaction(isolation, async (entityManager) => {
      const count = entityManager.count.bind(entityManager)
      entityManager.count = async (...countArgs: Parameters<EntityManager['count']>) => {
        const result = await count(...countArgs)
        if (!paused) {
          paused = true
          await waitForQueuedAdmission(dataSource, organizationId)
        }
        return result
      }
      return callback(entityManager)
    })
  })
}

function expectOneSuccessAndOneLimitFailure(results: PromiseSettledResult<unknown>[]): void {
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  expect(failures).toHaveLength(1)
  expect(failures[0].reason).toBeInstanceOf(BoxCreationLimitExceededError)
}

describeIfDatabase('BoxRepository creation admission (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let repository: BoxRepository
  let ownsSchema = false
  const invalidateOrgId = jest.fn()

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
    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId } as never,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."box_last_activity"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
  })

  it.each([
    { count: 0, limit: 100 },
    { count: 850, limit: 1000 },
  ])('persists two same-organization creates concurrently at $count of $limit', async ({ count, limit }) => {
    if (count > 0) await boxes.insert(Array.from({ length: count }, (_, i) => newBox(`seed-${i}`)))
    const inserted = gate()
    const commit = gate()
    const pids: number[] = []
    const originalQuery = EntityManager.prototype.query
    const insert = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await originalQuery.apply(this, args)
      if (String(args[0]).includes('WITH inserted_box AS') && this.queryRunner?.isTransactionActive) {
        const [{ pid }] = await this.query('SELECT pg_backend_pid() AS pid')
        pids.push(pid)
        if (pids.length === 2) inserted.open()
        await commit.ready
      }
      return result
    })
    const candidates = [newBox('parallel-a'), newBox('parallel-b')]
    const random = mockAdmissionLanes(0, 7)
    const requests = candidates.map((candidate) => repository.insert(candidate, limit))
    const creates = Promise.all(requests)
    try {
      await within(
        Promise.race([inserted.ready, creates]),
        'Two Box INSERTs did not overlap: the first transaction still has not committed',
      )
      // The pool has room for this observer while both writer connections are occupied.
      expect(await boxes.countBy({ organizationId })).toBe(count)
      expect(new Set(pids).size).toBe(2)
      const locks = await admissionLocks(dataSource)
      const lanes = pids.map((pid) => {
        const own = locks.filter((lock) => lock.pid === pid && lock.granted)
        expect(own).toHaveLength(2)
        expect(own).toContainEqual({
          pid,
          namespace: CREATION_ADMISSION_LOCK_NAMESPACE,
          mode: 'ShareLock',
          granted: true,
        })
        return own.find((lock) => lock.mode === 'ExclusiveLock')?.namespace
      })
      expect(new Set(lanes)).toEqual(new Set([firstLaneNamespace, lastLaneNamespace]))
    } finally {
      commit.open()
      await Promise.allSettled(requests)
      insert.mockRestore()
      random.mockRestore()
    }
    await expect(creates).resolves.toEqual(candidates)
    expect(await boxes.countBy({ organizationId })).toBe(count + 2)
    expect(await dataSource.getRepository(BoxLastActivity).count()).toBe(2)
  })

  it('shares the original key with an exclusive-only writer and counts each predecessor after commit', async () => {
    const firstInserted = gate()
    const releaseFirst = gate()
    const oldInserted = gate()
    const releaseOld = gate()
    const snapshots: number[] = []
    const originalCount = EntityManager.prototype.count
    const count = jest.spyOn(EntityManager.prototype, 'count').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['count']>
    ) {
      const result = await originalCount.apply(this, args)
      if (args[0] === Box && this.queryRunner?.isTransactionActive) snapshots.push(result)
      return result
    })
    const originalQuery = EntityManager.prototype.query
    const insert = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await originalQuery.apply(this, args)
      if (String(args[0]).includes('WITH inserted_box AS') && Array.isArray(args[1]) && args[1].includes('first-shared')) {
        firstInserted.open()
        await releaseFirst.ready
      }
      return result
    })
    const random = mockAdmissionLanes(0, 7)
    const first = repository.insert(newBox('first-shared'), 100)
    const requests: Promise<unknown>[] = [first]
    try {
      await within(Promise.race([firstInserted.ready, first]), 'First shared writer did not reach INSERT')
      const oldWriter = dataSource.transaction('READ COMMITTED', async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
          CREATION_ADMISSION_LOCK_NAMESPACE,
          organizationId,
        ])
        await manager.count(Box, { where: { organizationId } })
        await manager.insert(Box, newBox('old-exclusive'))
        oldInserted.open()
        await releaseOld.ready
      })
      requests.push(oldWriter)
      await Promise.race([waitForCompatibilityWaiter(dataSource, 'ExclusiveLock'), oldWriter])
      const later = repository.insert(newBox('later-shared'), 100)
      requests.push(later)
      await Promise.race([waitForCompatibilityWaiter(dataSource, 'ShareLock'), later])
      releaseFirst.open()
      await within(Promise.race([oldInserted.ready, oldWriter]), 'Exclusive-only writer did not reach INSERT')
      await waitForCompatibilityWaiter(dataSource, 'ShareLock')
      expect(snapshots).toEqual([0, 1])
      releaseOld.open()
      await Promise.all(requests)
      expect(snapshots).toEqual([0, 1, 2])
    } finally {
      releaseFirst.open()
      releaseOld.open()
      await Promise.allSettled(requests)
      count.mockRestore()
      insert.mockRestore()
      random.mockRestore()
    }
  })

  it('admits higher-limit inserts against their own limit while a lower-limit count is paused', async () => {
    await boxes.insert(Array.from({ length: 92 }, (_, i) => newBox(`seed-${i}`)))
    const counted = gate()
    const releaseCount = gate()
    const higher = ['higher-limit', 'higher-limit-again'].map((name) => ({
      candidate: newBox(name),
      inserted: gate(),
      commit: gate(),
    }))
    let lowerPid: number
    const originalCount = EntityManager.prototype.count
    const count = jest.spyOn(EntityManager.prototype, 'count').mockImplementationOnce(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['count']>
    ) {
      const result = await originalCount.apply(this, args)
      const [{ pid }] = await this.query('SELECT pg_backend_pid() AS pid')
      lowerPid = pid
      counted.open()
      await releaseCount.ready
      return result
    })
    const originalQuery = EntityManager.prototype.query
    const insert = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await originalQuery.apply(this, args)
      const attempt = higher.find(
        ({ candidate }) =>
          String(args[0]).includes('WITH inserted_box AS') && Array.isArray(args[1]) && args[1].includes(candidate.id),
      )
      if (attempt) {
        attempt.inserted.open()
        await attempt.commit.ready
      }
      return result
    })
    // Reuse the same lane for both higher-limit writes while the lower-limit writer is paused.
    const random = mockAdmissionLanes(0, 7, 7)
    const low = repository.insert(newBox('lower-limit'), 100)
    const requests = [low]
    try {
      await within(Promise.race([counted.ready, low]), 'Lower-limit writer did not take its count snapshot')
      expect(await boxes.countBy({ organizationId })).toBe(92)
      let firstHigherLane: number | undefined
      for (const [i, { candidate, inserted, commit }] of higher.entries()) {
        const request = repository.insert(candidate, 200)
        requests.push(request)
        await within(Promise.race([inserted.ready, request]), `${candidate.name} waited on the lower-limit writer`)
        const locks = await admissionLocks(dataSource)
        const shared = locks.filter((lock) => lock.namespace === CREATION_ADMISSION_LOCK_NAMESPACE)
        const lanes = locks.filter((lock) => lock.namespace !== CREATION_ADMISSION_LOCK_NAMESPACE)
        expect(shared).toHaveLength(2)
        expect(lanes).toHaveLength(2)
        for (const lock of shared) {
          expect(lock).toMatchObject({ mode: 'ShareLock', granted: true })
          expect(lanes.filter((lane) => lane.pid === lock.pid)).toEqual([
            expect.objectContaining({ mode: 'ExclusiveLock', granted: true }),
          ])
        }
        expect(new Set(lanes.map((lane) => lane.namespace)).size).toBe(2)
        expect(shared.map((lock) => lock.pid)).toContain(lowerPid)
        const higherLane = lanes.find((lane) => lane.pid !== lowerPid)?.namespace
        if (i === 0) firstHigherLane = higherLane
        else expect(higherLane).toBe(firstHigherLane)
        expect(await boxes.countBy({ organizationId })).toBe(92 + i)
        commit.open()
        await request
        expect(await boxes.countBy({ organizationId })).toBe(93 + i)
      }
      releaseCount.open()
      await low
      expect(await boxes.countBy({ organizationId })).toBe(95)
    } finally {
      releaseCount.open()
      for (const { commit } of higher) commit.open()
      await Promise.allSettled(requests)
      count.mockRestore()
      insert.mockRestore()
      random.mockRestore()
    }
  })

  it.each([1, 2])('releases the probe connection before exact fallback at pool size %d', async (max) => {
    await boxes.insert(Array.from({ length: 99 }, (_, i) => newBox(`seed-${i}`)))
    const narrowPool = await new DataSource({
      ...dataSource.options,
      extra: { ...dataSource.options.extra, max, connectionTimeoutMillis: 1000 },
    }).initialize()
    const random = mockAdmissionLanes(0, 7)
    try {
      const repo = new BoxRepository(narrowPool, { emit: jest.fn() } as never, { invalidateOrgId } as never)
      const results = await Promise.allSettled([
        repo.insert(newBox('near-limit-a'), 100),
        repo.insert(newBox('near-limit-b'), 100),
      ])
      expectOneSuccessAndOneLimitFailure(results)
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(failure?.reason.getResponse().message).toContain('100 of 100')
      expect(await boxes.countBy({ organizationId })).toBe(100)
      expect(await dataSource.getRepository(BoxLastActivity).count()).toBe(1)
      expect(await admissionLocks(dataSource)).toEqual([])
    } finally {
      random.mockRestore()
      await narrowPool.destroy()
    }
  })

  it('rolls back the Box and releases both locks when last-activity persistence fails', async () => {
    const candidate = newBox('activity-rolls-back')
    const failure = new Error('last activity unavailable')
    const originalQuery = EntityManager.prototype.query
    const upsert = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      if (String(args[0]).includes('WITH inserted_box AS')) throw failure
      return originalQuery.apply(this, args)
    })
    try {
      await expect(repository.insert(candidate, 100)).rejects.toBe(failure)
      expect(upsert.mock.calls.filter(([sql]) => String(sql).includes('WITH inserted_box AS'))).toHaveLength(1)
      expect(await boxes.countBy({ organizationId })).toBe(0)
      expect(await admissionLocks(dataSource)).toEqual([])
    } finally {
      upsert.mockRestore()
    }
    await expect(repository.insert(candidate, 100)).resolves.toBe(candidate)
    expect(await dataSource.getRepository(BoxLastActivity).count()).toBe(1)
  })

  it('allows exactly one of two fresh creates competing for the final slot', async () => {
    const barrier = installInitialCountBarrier(dataSource)
    try {
      const results = await Promise.allSettled([
        repository.insert(newBox('fresh-a'), 1),
        repository.insert(newBox('fresh-b'), 1),
      ])

      expectOneSuccessAndOneLimitFailure(results)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    } finally {
      barrier.mockRestore()
    }
  })

  it('serializes a fresh create against a warm-pool ownership assignment', async () => {
    const warmPoolBox = newBox('warm', BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    warmPoolBox.state = BoxState.STARTED
    warmPoolBox.pending = false
    await boxes.insert(warmPoolBox)

    const barrier = installInitialCountBarrier(dataSource)
    try {
      const results = await Promise.allSettled([
        repository.insert(newBox('fresh'), 1),
        repository.update(warmPoolBox.id, {
          updateData: { organizationId, name: 'claimed-warm' },
          entity: warmPoolBox,
          maxCreatedBoxes: 1,
        }),
      ])

      expectOneSuccessAndOneLimitFailure(results)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    } finally {
      barrier.mockRestore()
    }
  })

  it('enforces the limit after a committed create whose lookup cache invalidation fails', async () => {
    invalidateOrgId.mockImplementationOnce(() => {
      throw new Error('cache unavailable')
    })

    await expect(repository.insert(newBox('admitted'), 1)).resolves.toBeInstanceOf(Box)
    await expect(repository.insert(newBox('rejected'), 1)).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(invalidateOrgId).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId, name: 'admitted' }))
    expect(await boxes.countBy({ organizationId })).toBe(1)
  })

  it('lets a warm-pool assignment outwait a Box row lock held past the admission lock timeout', async () => {
    const warmPoolBox = newBox('warm-locked', BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    warmPoolBox.state = BoxState.STARTED
    warmPoolBox.pending = false
    await boxes.insert(warmPoolBox)

    // Stands in for updateWhere(): start/stop/sync hold this row lock.
    const rowLockHolder = dataSource.createQueryRunner()
    await rowLockHolder.connect()
    await rowLockHolder.startTransaction()
    try {
      await rowLockHolder.manager.findOne(Box, { where: { id: warmPoolBox.id }, lock: { mode: 'pessimistic_write' } })

      const assigning = repository.update(warmPoolBox.id, {
        updateData: { organizationId, name: 'claimed-locked' },
        entity: warmPoolBox,
        maxCreatedBoxes: 1,
      })
      const settled = assigning.then(
        () => undefined,
        (error: unknown) => error,
      )
      const earlyFailure = await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 6000)),
      ])
      expect(earlyFailure).toBe('still-waiting')

      await rowLockHolder.commitTransaction()
      await expect(assigning).resolves.toBeInstanceOf(Box)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    } finally {
      if (rowLockHolder.isTransactionActive) {
        await rowLockHolder.rollbackTransaction()
      }
      await rowLockHolder.release()
    }
  }, 20_000)

  it('returns the admission 503 once the advisory lock wait passes the admission lock timeout', async () => {
    const lockHolder = dataSource.createQueryRunner()
    await lockHolder.connect()
    await lockHolder.startTransaction()
    try {
      await lockHolder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        CREATION_ADMISSION_LOCK_NAMESPACE,
        organizationId,
      ])

      await expect(repository.insert(newBox('blocked'), 1)).rejects.toBeInstanceOf(BoxCreationAdmissionUnavailableError)
      expect(await boxes.countBy({ organizationId })).toBe(0)
    } finally {
      await lockHolder.rollbackTransaction()
      await lockHolder.release()
    }
  }, 20_000)

  it('admits a same-organization burst up to the limit without contention failures', async () => {
    const burst = 50
    const results = await Promise.allSettled(
      Array.from({ length: burst }, (_, index) => repository.insert(newBox(`burst-${index}`), burst)),
    )

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(failures.map((failure) => (failure.reason as Error).name)).toEqual([])
    expect(await boxes.countBy({ organizationId })).toBe(burst)
  })

  it.each(Object.values(BoxState))('applies the creation-count policy to state %s', async (state) => {
    const existing = newBox(`existing-${state}`)
    existing.state = state
    await boxes.insert(existing)

    const creating = repository.insert(newBox(`candidate-${state}`), 1)
    if (excludedStates.has(state)) {
      await expect(creating).resolves.toBeInstanceOf(Box)
      expect(await boxes.countBy({ organizationId })).toBe(2)
    } else {
      await expect(creating).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
      expect(await boxes.countBy({ organizationId })).toBe(1)
    }
  })

  it('writes a simple Box and its initial activity in one statement without an explicit transaction', async () => {
    const afterWrite = jest.spyOn(repository as any, 'afterBoxWrite').mockResolvedValue(undefined)
    const transaction = jest.spyOn(dataSource, 'transaction')
    const query = jest.spyOn(dataSource.manager, 'query')
    const entity = newBox('combined-insert')
    entity.env = { NODE_ENV: 'test' }
    entity.labels = { source: 'integration' }
    entity.entrypoint = ['sh']
    entity.cmd = ['-c', 'true']
    entity.outboundEnabled = true
    entity.outboundAllowNet = ['10.0.0.0/8']

    try {
      await repository.insert(entity)

      const persisted = await boxes.findOneByOrFail({ id: entity.id })
      expect(persisted.env).toEqual({ NODE_ENV: 'test' })
      expect(persisted.labels).toEqual({ source: 'integration' })
      expect(persisted.entrypoint).toEqual(['sh'])
      expect(persisted.cmd).toEqual(['-c', 'true'])
      expect(persisted.outboundAllowNet).toEqual(['10.0.0.0/8'])
      const activity = await dataSource.query(
        'SELECT "lastActivityAt" FROM box_last_activity WHERE "boxId"=$1',
        [entity.id],
      )
      expect(activity[0].lastActivityAt).toEqual(persisted.createdAt)
      expect(query.mock.calls.some(([sql]) => String(sql).includes('WITH inserted_box AS'))).toBe(true)
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      afterWrite.mockRestore()
      transaction.mockRestore()
      query.mockRestore()
    }
  })

  it('keeps an additional persistence callback inside a transaction', async () => {
    const afterWrite = jest.spyOn(repository as any, 'afterBoxWrite').mockResolvedValue(undefined)
    const callback = jest.fn(async (manager: EntityManager) => {
      expect(manager.queryRunner?.isTransactionActive).toBe(true)
    })
    try {
      await repository.insert(newBox('callback-transaction'), undefined, callback)
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      afterWrite.mockRestore()
    }
  })

  it('does not leave a Box when the combined activity write fails', async () => {
    const afterWrite = jest.spyOn(repository as any, 'afterBoxWrite').mockResolvedValue(undefined)
    await dataSource.query(`CREATE FUNCTION fail_box_activity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'activity write refused'; END
    $$`)
    await dataSource.query(
      'CREATE TRIGGER fail_box_activity BEFORE INSERT ON box_last_activity EXECUTE FUNCTION fail_box_activity()',
    )
    try {
      await expect(repository.insert(newBox('activity-failure'))).rejects.toThrow('activity write refused')
      expect(await boxes.countBy({ name: 'activity-failure' })).toBe(0)
    } finally {
      await dataSource.query('DROP TRIGGER fail_box_activity ON box_last_activity')
      await dataSource.query('DROP FUNCTION fail_box_activity()')
      afterWrite.mockRestore()
    }
  })
})
