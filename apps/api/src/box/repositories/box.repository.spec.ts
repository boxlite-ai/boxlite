/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxRepository } from './box.repository'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

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
function makeRepository(execute: jest.Mock) {
  const query = jest.fn().mockResolvedValue(undefined)
  const queryBuilder = makeQueryBuilder(execute)
  // create() hydrates the RETURNING * raw row into a Box; the stub echoes the
  // row back so return-shape assertions stay on the same object.
  const create = jest.fn((_entity, raw) => raw)
  const entityManager = {
    query,
    createQueryBuilder: jest.fn(() => queryBuilder),
    create,
  }
  const manager = {
    transaction: jest.fn(async (cb: (em: typeof entityManager) => Promise<unknown>) => cb(entityManager)),
  }
  const dataSource = { getRepository: () => ({ manager }) } as any
  const repo = new (BoxRepository as any)(dataSource, {} as any, {} as any, { transition: jest.fn() } as any)
  // invalidateLookupCacheOnUpdate touches the real cache service; stub it out —
  // it is incidental to the lock-timeout behavior under test.
  jest.spyOn(repo as any, 'invalidateLookupCacheOnUpdate').mockImplementation(() => undefined)
  return { repo, query, execute, create }
}

const startedRow = {
  id: 'box-1',
  organizationId: 'org-1',
  name: 'box-1',
  authToken: 'redacted',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STARTED,
  pending: true,
  updatedAt: new Date('2026-07-22T00:00:00.000Z'),
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

describe('BoxRepository metering transaction', () => {
  it('synchronizes usage in the same transaction that accepts a stop intent', async () => {
    const box = new Box('region-1', 'box-1')
    box.id = 'box000000001'
    box.organizationId = '00000000-0000-0000-0000-000000000001'
    box.state = BoxState.STARTED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = false
    box.createdAt = new Date('2026-07-22T00:00:00.000Z')
    box.updatedAt = box.createdAt

    const entityManager = {
      findOne: jest.fn().mockResolvedValue(box),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    }
    const transaction = jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
      callback(entityManager),
    )
    const dataSource = {
      getRepository: () => ({ manager: { transaction } }),
    } as any
    const usagePeriodWriter = {
      transition: jest.fn().mockResolvedValue(undefined),
    }
    const repository = new (BoxRepository as any)(dataSource, { emit: jest.fn() }, {}, usagePeriodWriter)
    jest.spyOn(repository as any, 'invalidateLookupCacheOnUpdate').mockImplementation(() => undefined)

    await repository.updateWhere(box.id, {
      updateData: { pending: true, desiredState: BoxDesiredState.STOPPED },
      whereCondition: { pending: false, state: BoxState.STARTED },
    })

    expect(usagePeriodWriter.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        manager: entityManager,
        previousBox: expect.objectContaining({ desiredState: BoxDesiredState.STARTED }),
        currentBox: expect.objectContaining({ desiredState: BoxDesiredState.STOPPED }),
        transitionAt: expect.any(Date),
      }),
    )
  })

  it('updates a supplied entity in place after the transaction commits', async () => {
    const supplied = new Box('region-1', 'box-1')
    supplied.id = 'box000000001'
    supplied.organizationId = '00000000-0000-0000-0000-000000000001'
    supplied.state = BoxState.STARTED
    supplied.desiredState = BoxDesiredState.STARTED
    supplied.pending = false
    supplied.createdAt = new Date('2026-07-22T00:00:00.000Z')
    supplied.updatedAt = supplied.createdAt
    const persisted = Object.assign(new Box(supplied.region, supplied.name), supplied)

    const entityManager = {
      findOne: jest.fn().mockResolvedValue(persisted),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    }
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
        callback(entityManager),
      ),
      getRepository: () => ({
        manager: {
          transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
            callback(entityManager),
          ),
        },
      }),
    } as any
    const repository = new (BoxRepository as any)(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn() } as never,
      { transition: jest.fn().mockResolvedValue(undefined) } as never,
    )

    const result = await repository.update(supplied.id, {
      entity: supplied,
      updateData: { desiredState: BoxDesiredState.STOPPED },
    })

    expect(result).toBe(supplied)
    expect(supplied).toMatchObject({ desiredState: BoxDesiredState.STOPPED, pending: true })
  })

  it('allows the action that created a lifecycle Job to persist its transitional state', async () => {
    const supplied = new Box('region-1', 'box-1')
    supplied.id = 'box000000001'
    supplied.organizationId = '00000000-0000-0000-0000-000000000001'
    supplied.state = BoxState.STOPPED
    supplied.desiredState = BoxDesiredState.STARTED
    supplied.pending = true
    supplied.createdAt = new Date('2026-07-22T00:00:00.000Z')
    supplied.updatedAt = supplied.createdAt

    const persisted = Object.assign(new Box(supplied.region, supplied.name), supplied, {
      lifecycleJobId: '00000000-0000-0000-0000-000000000010',
    })
    const entityManager = {
      findOne: jest.fn().mockResolvedValue(persisted),
      query: jest.fn().mockResolvedValue([{ now: new Date('2026-07-22T00:00:01.000Z') }]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    }
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
        callback(entityManager),
      ),
      getRepository: () => ({ manager: { transaction: jest.fn() } }),
    } as any
    const repository = new (BoxRepository as any)(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn() } as never,
      { transition: jest.fn().mockResolvedValue(undefined) } as never,
    )

    await expect(
      repository.update(supplied.id, {
        entity: supplied,
        updateData: { state: BoxState.STARTING },
      }),
    ).resolves.toBe(supplied)
    expect(supplied).toMatchObject({
      state: BoxState.STARTING,
      lifecycleJobId: persisted.lifecycleJobId,
    })
  })

  it('rejects a terminal lifecycle update after ownership moved to another Job', async () => {
    const supplied = new Box('region-1', 'box-1')
    supplied.id = 'box000000001'
    supplied.organizationId = '00000000-0000-0000-0000-000000000001'
    supplied.state = BoxState.STARTING
    supplied.desiredState = BoxDesiredState.STARTED
    supplied.pending = true
    supplied.lifecycleJobId = '00000000-0000-0000-0000-000000000010'
    supplied.createdAt = new Date('2026-07-22T00:00:00.000Z')
    supplied.updatedAt = supplied.createdAt

    const persisted = Object.assign(new Box(supplied.region, supplied.name), supplied, {
      lifecycleJobId: '00000000-0000-0000-0000-000000000011',
    })
    const entityManager = { findOne: jest.fn().mockResolvedValue(persisted) }
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: typeof entityManager) => Promise<unknown>) =>
        callback(entityManager),
      ),
      getRepository: () => ({ manager: { transaction: jest.fn() } }),
    } as any
    const repository = new (BoxRepository as any)(dataSource, {}, {}, { transition: jest.fn() })

    await expect(
      repository.update(supplied.id, {
        entity: supplied,
        updateData: { state: BoxState.STARTED, lifecycleJobId: null },
      }),
    ).rejects.toMatchObject({ name: 'BoxConflictError' })
  })
})
