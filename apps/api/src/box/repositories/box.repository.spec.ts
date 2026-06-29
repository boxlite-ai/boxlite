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
  const repo = new BoxRepository(dataSource, {} as any, {} as any)
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
