/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, EntityManager } from 'typeorm'
import { BoxRepository } from './box.repository'

// What the marker makes of the two steps it drives, with no database behind it.
// The companion *.integration.spec.ts proves what Postgres does with the
// statements the query builders produce; this covers what is decided in
// TypeScript — that the claim runs in one transaction, that a tick with nothing
// to claim opens no migration, and which of the two steps the count comes from.
describe('BoxRepository.markParkedBoxesForExport', () => {
  let repository: BoxRepository
  let transaction: jest.Mock
  let parkedBoxes: Array<{ id: string; updatedAt: Date }>
  let insertedRows: Array<{ boxId: string }>
  let insertBuilders: number

  // Every builder call chains except the ones that end a step, so a step is
  // recorded by what it returns: the locked boxes, or the rows the insert's
  // conflict guard let through.
  function queryBuilderStub(onInsert: () => void): Record<string, unknown> {
    const steps: Record<string, unknown> = {
      getRawMany: () => Promise.resolve(parkedBoxes),
      execute: () => Promise.resolve({ raw: insertedRows }),
      getQuery: () => '(SELECT 1)',
      insert: () => {
        onInsert()
        return builder
      },
    }
    const builder: Record<string, unknown> = new Proxy(steps, {
      // Anything the builder is asked for that does not end a step chains, so a
      // call the repository adds keeps working without touching this stub.
      get: (target, property) => (typeof property === 'string' ? (target[property] ?? (() => builder)) : undefined),
    })
    return builder
  }

  beforeEach(() => {
    parkedBoxes = []
    insertedRows = []
    insertBuilders = 0

    const entityManager = {
      createQueryBuilder: () => queryBuilderStub(() => insertBuilders++),
      // The insert's conflict guard names the table it upserts into, which the
      // manager carries the entity metadata for. What that name produces is the
      // integration spec's to check; here it only has to be answerable.
      connection: { getMetadata: () => ({ tableName: 'box_migration' }) },
    } as unknown as EntityManager

    transaction = jest.fn((runInTransaction: (manager: EntityManager) => Promise<number>) =>
      runInTransaction(entityManager),
    )

    const dataSource = {
      getRepository: () => ({ manager: { transaction } }),
    } as unknown as DataSource

    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as any,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as any,
    )
  })

  it('claims and opens the migrations inside one transaction', async () => {
    parkedBoxes = [{ id: 'box-a', updatedAt: new Date() }]
    insertedRows = [{ boxId: 'box-a' }]

    expect(await repository.markParkedBoxesForExport(['runner-a'])).toBe(1)

    // The select's row locks are what keep the copied stamp true until the insert
    // lands, and those last only as long as the transaction holding them.
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(insertBuilders).toBe(1)
  })

  it('counts the boxes the insert claimed, not the ones it locked', async () => {
    // A box the select locked can still lose its claim: a migration opened
    // between the two steps is invisible to the select and fails the insert's
    // conflict guard, so the box is left for the next tick.
    parkedBoxes = [
      { id: 'box-a', updatedAt: new Date() },
      { id: 'box-b', updatedAt: new Date() },
    ]
    insertedRows = [{ boxId: 'box-a' }]

    expect(await repository.markParkedBoxesForExport(['runner-a'])).toBe(1)
  })

  it('opens no migration when no box is claimable', async () => {
    expect(await repository.markParkedBoxesForExport(['runner-a'])).toBe(0)

    // An insert built from no boxes would be a statement with an empty VALUES
    // list, which TypeORM answers with a result that has no rows to count.
    expect(insertBuilders).toBe(0)
  })

  it('sends nothing when no runner is draining', async () => {
    expect(await repository.markParkedBoxesForExport([])).toBe(0)

    // An empty id list would make the runner predicate match every box in the
    // fleet, so nothing must be sent at all.
    expect(transaction).not.toHaveBeenCalled()
  })
})
