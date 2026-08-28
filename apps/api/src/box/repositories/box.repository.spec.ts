/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxRepository } from './box.repository'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

// A chainable query-builder stub whose UPDATE and COUNT terminals are supplied
// per-test. update/set/where/andWhere/returning all return the same builder.
function makeQueryBuilder(execute: jest.Mock, getCount = jest.fn()) {
  const qb: any = {}
  qb.update = jest.fn(() => qb)
  qb.set = jest.fn(() => qb)
  qb.where = jest.fn(() => qb)
  qb.andWhere = jest.fn(() => qb)
  qb.returning = jest.fn(() => qb)
  qb.execute = execute
  qb.getCount = getCount
  return qb
}

// Build a BoxRepository whose `manager.transaction` runs the callback against a
// fake entityManager. We bypass DI: these tests exercise the repository query
// builder, `manager` (a BaseRepository getter), and cache invalidation only.
function makeRepository(execute: jest.Mock, getCount = jest.fn()) {
  const query = jest.fn().mockResolvedValue(undefined)
  const queryBuilder = makeQueryBuilder(execute, getCount)
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
  const ormRepository = { manager, createQueryBuilder: jest.fn(() => queryBuilder) }
  const dataSource = { getRepository: () => ormRepository } as any
  const repo = new BoxRepository(dataSource, {} as any, {} as any)
  // invalidateLookupCacheOnUpdate touches the real cache service; stub it out —
  // it is incidental to the lock-timeout behavior under test.
  jest.spyOn(repo as any, 'invalidateLookupCacheOnUpdate').mockImplementation(() => undefined)
  return { repo, query, execute, create, queryBuilder }
}

const startedRow = {
  id: 'box-1',
  organizationId: 'org-1',
  name: 'box-1',
  authToken: 'redacted',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STARTED,
  pending: true,
}

describe('BoxRepository.countQuotaBoxes', () => {
  it('counts every organization box except destroyed and archived boxes', async () => {
    const getCount = jest.fn().mockResolvedValue(7)
    const { repo, queryBuilder } = makeRepository(jest.fn(), getCount)

    await expect(repo.countQuotaBoxes('org-1')).resolves.toBe(7)
    expect(queryBuilder.where).toHaveBeenCalledWith('box.organizationId = :organizationId', {
      organizationId: 'org-1',
    })
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('box.state NOT IN (:...excludedStates)', {
      excludedStates: [BoxState.DESTROYED, BoxState.ARCHIVED],
    })
  })
})

describe('BoxRepository inventory commit fence', () => {
  function makeInventoryRepository(currentCount: number) {
    const getCount = jest.fn().mockResolvedValue(currentCount)
    const countQueryBuilder = makeQueryBuilder(jest.fn(), getCount)
    const query = jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }])
    const insert = jest.fn().mockResolvedValue(undefined)
    const upsert = jest.fn().mockResolvedValue(undefined)
    const entityManager = {
      query,
      createQueryBuilder: jest.fn(() => countQueryBuilder),
      insert,
      upsert,
    }
    const transaction = jest.fn(async (callback: (manager: typeof entityManager) => Promise<void>) =>
      callback(entityManager),
    )
    const ormRepository = { createQueryBuilder: jest.fn(() => countQueryBuilder) }
    const dataSource = { getRepository: () => ormRepository, transaction } as any
    const repo = new BoxRepository(dataSource, {} as any, { invalidateOrgId: jest.fn() } as any)
    const box = {
      id: 'box-1',
      name: 'box-1',
      organizationId: 'org-1',
      assertValid: jest.fn(),
      enforceInvariants: jest.fn(),
    } as any
    return { repo, box, query, getCount, insert, upsert }
  }

  it('locks, recounts, and inserts in one short transaction', async () => {
    const { repo, box, query, getCount, insert } = makeInventoryRepository(19)

    await repo.insert(box, { inventoryLimit: 20 })

    expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['org-1'])
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(getCount.mock.invocationCallOrder[0])
    expect(getCount.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0])
  })

  it('does not insert after the fenced recount reaches the limit', async () => {
    const { repo, box, insert } = makeInventoryRepository(20)

    await expect(repo.insert(box, { inventoryLimit: 20 })).rejects.toMatchObject({
      current: 20,
      limit: 20,
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('rolls back when reservation ownership is lost during insert', async () => {
    const { repo, box, insert, upsert } = makeInventoryRepository(19)
    const controller = new AbortController()
    insert.mockImplementation(async () => controller.abort(new Error('reservation lost')))

    await expect(repo.insert(box, { inventoryLimit: 20, admissionSignal: controller.signal })).rejects.toThrow(
      'reservation lost',
    )
    expect(upsert).not.toHaveBeenCalled()
  })
})

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
