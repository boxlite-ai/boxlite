/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxCreationAdmissionUnavailableError, BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { BoxRepository, CREATION_ADMISSION_LOCK_NAMESPACE } from './box.repository'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_creation_limit_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = '00000000-0000-4000-8000-0000000000aa'

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
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    boxes = dataSource.getRepository(Box)
    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
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
})
