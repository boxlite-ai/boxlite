/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { BoxRepository } from './box.repository'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'

// A chainable UPDATE query-builder stub whose terminal execute() is supplied
// per-test. update/set/where/andWhere/returning all return the same builder.
function makeQueryBuilder(execute: jest.Mock) {
  const qb: any = {}
  qb.update = jest.fn(() => qb)
  qb.set = jest.fn(() => qb)
  qb.where = jest.fn(() => qb)
  qb.andWhere = jest.fn(() => qb)
  qb.returning = jest.fn(() => qb)
  qb.execute = execute
  return qb
}

// Build a BoxRepository whose `manager.transaction` runs the callback against a
// fake entityManager. We bypass DI: only `manager` (a BaseRepository getter
// over repository.manager) and the cache-invalidation hook are exercised here.
function makeRepository(execute: jest.Mock, configService?: { get: (key: string) => unknown }) {
  const query = jest.fn().mockResolvedValue(undefined)
  const findOne = jest.fn()
  const queryBuilder = makeQueryBuilder(execute)
  // create() hydrates the RETURNING * raw row into a Box; the stub echoes the
  // row back so return-shape assertions stay on the same object.
  const create = jest.fn((_entity, raw) => raw)
  const entityManager = {
    query,
    findOne,
    createQueryBuilder: jest.fn(() => queryBuilder),
    create,
  }
  const manager = {
    transaction: jest.fn(async (cb: (em: typeof entityManager) => Promise<unknown>) => cb(entityManager)),
  }
  const dataSource = { getRepository: () => ({ manager }) } as any
  const repo = new BoxRepository(dataSource, {} as any, {} as any, configService as any)
  // invalidateLookupCacheOnUpdate touches the real cache service; stub it out —
  // it is incidental to the lock-timeout behavior under test.
  jest.spyOn(repo as any, 'invalidateLookupCacheOnUpdate').mockImplementation(() => undefined)
  return { repo, query, execute, create, findOne }
}

describe('BoxRepository organization activity', () => {
  it('does not make the committed Box write wait for activity persistence', async () => {
    const { repo } = makeRepository(jest.fn())
    let finish!: () => void
    ;(repo as any).manager.transaction = jest.fn().mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const box = Object.assign(new Box('region-1'), {
      id: 'box-1',
      organizationId: 'org-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    let settled = false
    const afterWrite = (repo as any).afterBoxWrite(box).finally(() => (settled = true))
    await new Promise(setImmediate)
    expect(settled).toBe(true)
    finish()
    await afterWrite
  })

  it('captures malformed activity snapshots without rejecting the background write', async () => {
    const { repo } = makeRepository(jest.fn())
    const box = Object.assign(new Box('region-1'), {
      id: 'box-1',
      organizationId: 'org-1',
      createdAt: undefined,
      updatedAt: new Date(),
    })
    const previous = {
      organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      createdAt: undefined,
    }

    await expect((repo as any).recordOrganizationActivity(box, previous)).resolves.toBeUndefined()
  })

  it('uses one synchronous write without retries when asynchronous activity is disabled', async () => {
    jest.useFakeTimers()
    const { repo } = makeRepository(jest.fn(), { get: () => false })
    const manager = (repo as any).manager
    manager.transaction = jest.fn().mockRejectedValueOnce(new Error('temporary failure'))
    const box = Object.assign(new Box('region-1'), {
      id: 'box-1',
      organizationId: 'org-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const afterWrite = (repo as any).afterBoxWrite(box)
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(afterWrite).resolves.toBeUndefined()
    expect(manager.transaction).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('stops after three failed asynchronous activity writes', async () => {
    jest.useFakeTimers()
    const { repo } = makeRepository(jest.fn())
    const manager = (repo as any).manager
    const error = jest.spyOn((repo as any).logger, 'error')
    manager.transaction = jest.fn().mockRejectedValue(new Error('persistent failure'))
    const box = Object.assign(new Box('region-1'), {
      id: 'box-1',
      organizationId: 'org-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const recording = (repo as any).recordOrganizationActivity(box)
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(recording).resolves.toBeUndefined()
    expect(manager.transaction).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'organization.activity.dropped', attempt: 3 }))
    jest.useRealTimers()
  })

  it('retries a failed activity upsert with bounded backoff', async () => {
    jest.useFakeTimers()
    const { repo } = makeRepository(jest.fn())
    const manager = (repo as any).manager
    manager.transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined)
    const box = Object.assign(new Box('region-1'), {
      id: 'box-1',
      organizationId: 'org-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const recording = (repo as any).recordOrganizationActivity(box)
    await jest.advanceTimersByTimeAsync(1_000)

    await expect(recording).resolves.toBeUndefined()
    expect(manager.transaction).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })
})

describe('BoxRepository lifecycle lookup', () => {
  function makeLifecycleRepository(results: Array<{ entities: Box[]; raw: any[] }>) {
    const queries: any[] = []
    const repository = {
      createQueryBuilder: jest.fn(() => {
        const query: any = {}
        query.leftJoin = jest.fn(() => query)
        query.addSelect = jest.fn(() => query)
        query.where = jest.fn(() => query)
        query.getRawAndEntities = jest.fn().mockImplementation(async () => results[queries.length - 1])
        queries.push(query)
        return query
      }),
    }
    const repo = Object.create(BoxRepository.prototype) as BoxRepository
    Object.assign(repo as any, { repository })
    return { repo, queries }
  }

  it('keeps primary-key ID ahead of a colliding Box name', async () => {
    const box = new Box('region-1', 'colliding-name')
    const { repo, queries } = makeLifecycleRepository([
      { entities: [box], raw: [{ checkpoint_job_id: null, checkpoint_sequence: null }] },
    ])

    await expect(repo.findWithCheckpointStateForLifecycle('box-id', 'org-1', 'id-or-name')).resolves.toMatchObject({
      box,
    })

    expect(queries).toHaveLength(1)
    expect(queries[0].where).toHaveBeenCalledWith({ id: 'box-id', organizationId: 'org-1', state: expect.anything() })
  })

  it('rejects ID-only lifecycle deletion without an organization', async () => {
    const { repo, queries } = makeLifecycleRepository([])

    await expect(repo.findWithCheckpointStateForLifecycle('box-1', undefined, 'id')).rejects.toThrow(NotFoundException)
    expect(queries).toHaveLength(0)
  })

  it('allows ID-only deletion to finish an existing destroy intent', async () => {
    const box = Object.assign(new Box('region-1'), {
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.DESTROYED,
    })
    const { repo } = makeLifecycleRepository([
      { entities: [box], raw: [{ checkpoint_job_id: null, checkpoint_sequence: null }] },
    ])

    await expect(repo.findWithCheckpointStateForLifecycle('box-1', 'org-1', 'id')).resolves.toMatchObject({ box })
  })

  it('falls back to name only after the primary-key lookup misses', async () => {
    const box = new Box('region-1', 'box-name')
    const { repo, queries } = makeLifecycleRepository([
      { entities: [], raw: [] },
      { entities: [box], raw: [{ checkpoint_job_id: null, checkpoint_sequence: null }] },
    ])

    await expect(repo.findWithCheckpointStateForLifecycle('box-name', 'org-1', 'id-or-name')).resolves.toMatchObject({
      box,
    })

    expect(queries).toHaveLength(2)
    expect(queries[0].where).toHaveBeenCalledWith({ id: 'box-name', organizationId: 'org-1', state: expect.anything() })
    expect(queries[1].where).toHaveBeenCalledWith({
      name: 'box-name',
      organizationId: 'org-1',
      state: expect.anything(),
    })
  })
})

describe('BoxRepository.updateWhere', () => {
  it.each([500, undefined])(
    'uses the optional lock timeout (%s) and propagates a row-lock failure',
    async (lockTimeoutMs) => {
      const { repo, query, findOne } = makeRepository(jest.fn())
      const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
      findOne.mockRejectedValue(lockTimeout)
      const params = {
        updateData: { pending: true, desiredState: BoxDesiredState.STOPPED },
        whereCondition: { pending: false, state: BoxState.STARTED },
        lockTimeoutMs,
      }

      await expect(repo.updateWhere('box-1', params)).rejects.toBe(lockTimeout)

      expect(findOne).toHaveBeenCalledWith(
        Box,
        expect.objectContaining({
          where: { id: 'box-1', pending: false, state: BoxState.STARTED },
          lock: { mode: 'pessimistic_write' },
        }),
      )
      if (lockTimeoutMs === undefined) {
        expect(query).not.toHaveBeenCalled()
      } else {
        expect(query).toHaveBeenCalledWith("SELECT set_config('lock_timeout', $1, true)", ['500ms'])
        expect(query.mock.invocationCallOrder[0]).toBeLessThan(findOne.mock.invocationCallOrder[0])
      }
    },
  )
})

const startedRow = {
  id: 'box-1',
  organizationId: 'org-1',
  name: 'box-1',
  authToken: 'redacted',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STARTED,
  pending: true,
}

describe('BoxRepository.conditionalStartForProxy', () => {
  it('bounds the row-lock wait with a lock_timeout before the UPDATE', async () => {
    const execute = jest.fn().mockResolvedValue({ raw: [startedRow] })
    const { repo, query, create } = makeRepository(execute)

    const updated = await repo.conditionalStartForProxy('box-1', 'org-1')

    expect(updated).toEqual(startedRow)
    // The RETURNING * row is a plain pg object; the repo must hydrate it into a
    // Box entity, not leak a raw row through the Promise<Box> contract.
    expect(create).toHaveBeenCalledWith(Box, startedRow)
    // The fix's core: the transaction sets a per-statement lock_timeout so a
    // contended row aborts at the DB instead of pinning the connection.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET LOCAL lock_timeout'))
    // ...and it must be armed BEFORE the UPDATE runs — otherwise the UPDATE
    // could block on the row lock with no bound. Assert call order, not just
    // presence.
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0])
  })

  // Lock wait exceeded lock_timeout (SQLSTATE 55P03): the row is being
  // started/stopped concurrently. Treated as a race-lost no-op, NOT propagated —
  // without the catch this rejects and surfaces as an error to the caller.
  it('returns null when the lock_timeout fires (SQLSTATE 55P03)', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    const execute = jest.fn().mockRejectedValue(lockTimeout)
    const { repo } = makeRepository(execute)

    await expect(repo.conditionalStartForProxy('box-1', 'org-1')).resolves.toBeNull()
  })

  it('re-throws DB errors that are not lock timeouts', async () => {
    const dbError = Object.assign(new Error('connection terminated'), { code: '08006' })
    const execute = jest.fn().mockRejectedValue(dbError)
    const { repo } = makeRepository(execute)

    await expect(repo.conditionalStartForProxy('box-1', 'org-1')).rejects.toThrow('connection terminated')
  })

  it('returns null when the conditional UPDATE matches no row', async () => {
    const execute = jest.fn().mockResolvedValue({ raw: [] })
    const { repo } = makeRepository(execute)

    await expect(repo.conditionalStartForProxy('box-1', 'org-1')).resolves.toBeNull()
  })
})
