/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BOX_STATES_CONSUMING_COMPUTE } from '../../organization/constants/box-consuming-states.constant'
import { ExpectedOpenPeriod, expectedOpenPeriod, sameShape } from './expected-usage-period'

const box = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const FULL_COMPUTE = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const DISK_ONLY = { cpu: 0, gpu: 0, mem: 0, disk: 10 }

describe('expectedOpenPeriod', () => {
  const cases: [BoxState, ExpectedOpenPeriod][] = [
    [BoxState.STARTED, FULL_COMPUTE],
    [BoxState.STOPPING, DISK_ONLY],
    [BoxState.STOPPED, DISK_ONLY],
    [BoxState.ERROR, null],
    [BoxState.ARCHIVED, null],
    [BoxState.DESTROYING, null],
    [BoxState.DESTROYED, null],
    [BoxState.CREATING, null],
    [BoxState.STARTING, null],
    [BoxState.RESTORING, null],
    [BoxState.RESIZING, null],
    [BoxState.UNKNOWN, null],
    [BoxState.ARCHIVING, null],
  ]

  it.each(cases)('bills %s as expected', (state, expected) => {
    expect(expectedOpenPeriod({ ...box, state })).toEqual(expected)
  })

  it('covers every box state', () => {
    expect(cases.map(([state]) => state).sort()).toEqual(Object.values(BoxState).sort())
  })

  it('bills nothing for a box that no longer exists', () => {
    expect(expectedOpenPeriod(null)).toBeNull()
    expect(expectedOpenPeriod(undefined)).toBeNull()
  })

  it('stops billing at the destroy request even before state reaches a terminal value', () => {
    expect(expectedOpenPeriod({ ...box, state: BoxState.STARTED, desiredState: BoxDesiredState.DESTROYED })).toBeNull()
  })

  it('does not reuse the quota rule for states where a box is not usable yet', () => {
    for (const state of [BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING]) {
      expect(BOX_STATES_CONSUMING_COMPUTE).toContain(state)
      expect(expectedOpenPeriod({ ...box, state })).toBeNull()
    }
  })
})

describe('sameShape', () => {
  it('accepts the expected resources and Postgres float noise', () => {
    expect(sameShape(FULL_COMPUTE, FULL_COMPUTE)).toBe(true)
    expect(sameShape({ ...FULL_COMPUTE, cpu: 0.1 + 0.2 }, { ...FULL_COMPUTE, cpu: 0.3 })).toBe(true)
  })

  it.each(['cpu', 'gpu', 'mem', 'disk'] as const)('rejects a material %s mismatch', (resource) => {
    expect(sameShape({ ...FULL_COMPUTE, [resource]: FULL_COMPUTE[resource] + 1 }, FULL_COMPUTE)).toBe(false)
  })
})
