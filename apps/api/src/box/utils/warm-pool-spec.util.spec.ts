/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getMetadataArgsStorage } from 'typeorm'
import { Box } from '../entities/box.entity'
import { WarmPool } from '../entities/warm-pool.entity'
import { BoxClass } from '../enums/box-class.enum'
import { warmPoolBoxWhere, warmPoolRowWhere, warmPoolSpecOfBox, warmPoolSpecOfRow } from './warm-pool-spec.util'

const SPEC = {
  image: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
  target: 'region-1',
  class: BoxClass.SMALL,
  cpu: 2,
  mem: 4,
  disk: 10,
  gpu: 0,
  osUser: 'boxlite',
  env: { A: '1' },
}

describe('warm pool spec', () => {
  /**
   * The index is what makes the lookup cheap, and the predicate is what makes
   * it correct; a field in one and not the other is either a slow query or a
   * box that matches on less than it was built with. Read off the entity rather
   * than restated here, so adding a column to the index fails this test until
   * the predicate has it too.
   */
  it('matches on exactly the fields warm_pool_find_idx covers', () => {
    const index = getMetadataArgsStorage().indices.find(
      (candidate) => candidate.target === WarmPool && candidate.name === 'warm_pool_find_idx',
    )

    expect(Object.keys(warmPoolRowWhere(SPEC)).sort()).toEqual([...(index?.columns as string[])].sort())
  })

  /**
   * The two tables name the region differently, which is the whole reason a box
   * cannot be matched with the pool row's own where-clause.
   */
  it('asks a box for the same fields under the column names a box uses', () => {
    const boxWhere = warmPoolBoxWhere(SPEC)

    expect(boxWhere.region).toBe(SPEC.target)
    expect(boxWhere).not.toHaveProperty('target')
    expect(Object.keys(boxWhere).sort()).toEqual(
      Object.keys(warmPoolRowWhere(SPEC))
        .map((field) => (field === 'target' ? 'region' : field))
        .sort(),
    )
  })

  /**
   * Callers pass rows and parameter objects that carry more than the tuple —
   * `FetchWarmPoolBoxParams` also carries the asking organization. Spreading
   * one of those into a where-clause asks the database for a column the table
   * does not have, which fails the query rather than the match.
   */
  it('ignores fields outside the tuple', () => {
    const where = warmPoolRowWhere({ ...SPEC, organizationId: 'org-1', state: 'started' } as never)

    expect(where).not.toHaveProperty('organizationId')
    expect(where).not.toHaveProperty('state')
  })

  it('reads the tuple off a pool row and off a box alike', () => {
    const row = { ...SPEC, id: 'pool-1', pool: 3, gpuType: 'a100' } as unknown as WarmPool
    const box = { ...SPEC, region: SPEC.target, id: 'box-1', organizationId: 'org-1' } as unknown as Box

    expect(warmPoolSpecOfRow(row)).toEqual(SPEC)
    expect(warmPoolSpecOfBox(box)).toEqual(SPEC)
  })
})
