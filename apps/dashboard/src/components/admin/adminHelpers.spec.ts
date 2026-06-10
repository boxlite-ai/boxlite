/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import {
  type AdminBox,
  type AdminRunner,
  filterOwnerGroups,
  getBoxBreakdown,
  groupBoxesByOwner,
  isErrorState,
  isOnlineRunner,
  runnerCpuPercent,
  selectErroringOwners,
  stateBadgeVariant,
  findBoxById,
} from './adminHelpers'

function box(partial: Partial<AdminBox> & Pick<AdminBox, 'id' | 'organizationId' | 'state'>): AdminBox {
  return {
    runnerId: 'rnr-1',
    cpu: 1,
    memoryGiB: 1,
    createdAt: '2026-05-20T00:00:00.000Z',
    owner: { name: 'Owner', email: 'owner@x.io', orgName: 'Org', personal: true },
    ...partial,
  }
}

function runner(partial: Partial<AdminRunner> & Pick<AdminRunner, 'id' | 'state'>): AdminRunner {
  return {
    cpu: 8,
    memory: 8,
    currentAllocatedCpu: 0,
    currentAllocatedMemoryGiB: 0,
    currentStartedBoxes: 0,
    availabilityScore: 1,
    draining: false,
    unschedulable: false,
    ...partial,
  }
}

describe('stateBadgeVariant', () => {
  it('maps healthy states to success', () => {
    expect(stateBadgeVariant('started')).toBe('success')
    expect(stateBadgeVariant('RUNNING')).toBe('success')
    expect(stateBadgeVariant('ready')).toBe('success')
  })
  it('maps failure states to destructive', () => {
    expect(stateBadgeVariant('error')).toBe('destructive')
    expect(stateBadgeVariant('build_failed')).toBe('destructive')
  })
  it('maps transitional states to warning', () => {
    expect(stateBadgeVariant('draining')).toBe('warning')
    expect(stateBadgeVariant('stopping')).toBe('warning')
  })
  it('falls back to secondary for unknown / idle states', () => {
    expect(stateBadgeVariant('stopped')).toBe('secondary')
    expect(stateBadgeVariant('whatever')).toBe('secondary')
  })
})

describe('isErrorState', () => {
  it('treats error and build_failed as error', () => {
    expect(isErrorState('error')).toBe(true)
    expect(isErrorState('build_failed')).toBe(true)
    expect(isErrorState('started')).toBe(false)
  })
})

describe('getBoxBreakdown', () => {
  it('counts by state in a stable order and folds the remainder into "other"', () => {
    const boxes = [
      box({ id: 'a', organizationId: 'o', state: 'started' }),
      box({ id: 'b', organizationId: 'o', state: 'started' }),
      box({ id: 'c', organizationId: 'o', state: 'error' }),
      box({ id: 'd', organizationId: 'o', state: 'build_failed' }),
      box({ id: 'e', organizationId: 'o', state: 'archived' }), // unknown → other
    ]
    const breakdown = getBoxBreakdown(boxes)
    expect(breakdown.map((s) => [s.key, s.count])).toEqual([
      ['started', 2],
      ['error', 1],
      ['build_failed', 1],
      ['other', 1],
    ])
  })
  it('omits zero-count segments', () => {
    const breakdown = getBoxBreakdown([box({ id: 'a', organizationId: 'o', state: 'started' })])
    expect(breakdown.every((s) => s.count > 0)).toBe(true)
    expect(breakdown.find((s) => s.key === 'error')).toBeUndefined()
  })
})

describe('groupBoxesByOwner', () => {
  const boxes = [
    box({ id: 'b1', organizationId: 'org-z', state: 'started', owner: ownerOf('Zoe') }),
    box({ id: 'b2', organizationId: 'org-a', state: 'error', owner: ownerOf('Adam') }),
    box({ id: 'b3', organizationId: 'org-a', state: 'started', owner: ownerOf('Adam') }),
  ]
  function ownerOf(name: string): AdminBox['owner'] {
    return { name, email: `${name.toLowerCase()}@x.io`, orgName: name, personal: true }
  }

  it('groups boxes by organizationId', () => {
    const groups = groupBoxesByOwner(boxes)
    const adam = groups.find((g) => g.organizationId === 'org-a')
    expect(adam?.boxes.map((b) => b.id).sort()).toEqual(['b2', 'b3'])
  })
  it('sorts groups by owner name', () => {
    const groups = groupBoxesByOwner(boxes)
    expect(groups.map((g) => g.owner.name)).toEqual(['Adam', 'Zoe'])
  })
  it('attaches a per-owner breakdown', () => {
    const groups = groupBoxesByOwner(boxes)
    const adam = groups.find((g) => g.organizationId === 'org-a')
    expect(adam?.breakdown.find((s) => s.key === 'error')?.count).toBe(1)
  })
})

describe('isOnlineRunner / runnerCpuPercent', () => {
  it('only READY runners are online', () => {
    expect(isOnlineRunner(runner({ id: 'r', state: 'ready' }))).toBe(true)
    expect(isOnlineRunner(runner({ id: 'r', state: 'unresponsive' }))).toBe(false)
  })
  it('computes allocated CPU ratio', () => {
    expect(runnerCpuPercent(runner({ id: 'r', state: 'ready', cpu: 8, currentAllocatedCpu: 6 }))).toBeCloseTo(0.75)
  })
  it('guards divide-by-zero capacity', () => {
    expect(runnerCpuPercent(runner({ id: 'r', state: 'error', cpu: 0, currentAllocatedCpu: 0 }))).toBe(0)
  })
})

describe('filterOwnerGroups', () => {
  const groups = groupBoxesByOwner([
    box({
      id: 'box-aaa',
      organizationId: 'org-brian',
      state: 'started',
      owner: { name: 'Brian Luo', email: 'brian@x.io', orgName: 'Brian', personal: true },
    }),
    box({
      id: 'box-bbb',
      organizationId: 'org-hao',
      state: 'error',
      owner: { name: 'Hao Luo', email: 'hao@x.io', orgName: 'Hao', personal: true },
    }),
  ])

  it('returns all groups for an empty query', () => {
    expect(filterOwnerGroups(groups, '').length).toBe(2)
  })
  it('matches an owner by name (case-insensitive) and keeps all their boxes', () => {
    const res = filterOwnerGroups(groups, 'BRIAN')
    expect(res.length).toBe(1)
    expect(res[0].owner.name).toBe('Brian Luo')
    expect(res[0].boxes.length).toBe(1)
  })
  it('matches a box by id and narrows the group to the matching box', () => {
    const res = filterOwnerGroups(groups, 'box-bbb')
    expect(res.length).toBe(1)
    expect(res[0].boxes.map((b) => b.id)).toEqual(['box-bbb'])
  })
  it('returns nothing when neither owner nor box matches', () => {
    expect(filterOwnerGroups(groups, 'zzz-nope').length).toBe(0)
  })
})

describe('selectErroringOwners', () => {
  it('keeps only owners with error/build_failed boxes, ranked by error count desc', () => {
    const groups = groupBoxesByOwner([
      box({
        id: 'a1',
        organizationId: 'org-a',
        state: 'error',
        owner: { name: 'A', email: 'a@x.io', orgName: 'A', personal: true },
      }),
      box({
        id: 'a2',
        organizationId: 'org-a',
        state: 'build_failed',
        owner: { name: 'A', email: 'a@x.io', orgName: 'A', personal: true },
      }),
      box({
        id: 'b1',
        organizationId: 'org-b',
        state: 'error',
        owner: { name: 'B', email: 'b@x.io', orgName: 'B', personal: true },
      }),
      box({
        id: 'c1',
        organizationId: 'org-c',
        state: 'started',
        owner: { name: 'C', email: 'c@x.io', orgName: 'C', personal: true },
      }),
    ])
    const ranked = selectErroringOwners(groups)
    expect(ranked.map((r) => r.group.owner.name)).toEqual(['A', 'B'])
    expect(ranked[0].errorBoxes.length).toBe(2)
  })
})

describe('findBoxById', () => {
  it('finds exact box ids case-insensitively so pasted UUIDs can open telemetry', () => {
    const groups = groupBoxesByOwner([
      box({
        id: '2479F61E-04D9-49F3-B7D9-CFAFBEE74D68',
        organizationId: 'org-a',
        state: 'error',
        owner: { name: 'Brian Luo', email: 'brian@x.io', orgName: 'Brian', personal: true },
      }),
    ])

    expect(findBoxById(groups, '2479f61e-04d9-49f3-b7d9-cfafbee74d68')?.box.state).toBe('error')
  })
})
