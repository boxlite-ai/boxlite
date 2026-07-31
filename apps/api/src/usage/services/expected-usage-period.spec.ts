/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_STATES_CONSUMING_COMPUTE } from '../../organization/constants/box-consuming-states.constant'
import { ExpectedOpenPeriod, expectedOpenPeriod, sameShape } from './expected-usage-period'

const box = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const FULL_COMPUTE = { cpu: 2, gpu: 1, mem: 4, disk: 10 }
const DISK_ONLY = { cpu: 0, gpu: 0, mem: 0, disk: 10 }

describe('expectedOpenPeriod', () => {
  // Every state is listed so a new BoxState cannot be added without deciding
  // what it bills — the exhaustiveness check below fails until it appears here.
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
    // No code in this repository puts a box into ARCHIVING, so it carries no
    // price. Deciding one here would be inventing a billing rule for a state
    // the product does not have yet.
    [BoxState.ARCHIVING, null],
  ]

  it.each(cases)('bills %s as expected', (state, expected) => {
    expect(expectedOpenPeriod({ ...box, state })).toEqual(expected)
  })

  it('covers every box state', () => {
    expect(cases.map(([state]) => state).sort()).toEqual(Object.values(BoxState).sort())
  })

  it('bills nothing for a box that no longer exists', () => {
    // the roll-over relies on this: a deleted box must not have its period
    // reopened, or it accrues forever with nothing left to reconcile against
    expect(expectedOpenPeriod(null)).toBeNull()
    expect(expectedOpenPeriod(undefined)).toBeNull()
  })

  it('charges a stopped box for disk but not for compute', () => {
    const stopped = expectedOpenPeriod({ ...box, state: BoxState.STOPPED })

    expect(stopped).toEqual({ cpu: 0, gpu: 0, mem: 0, disk: box.disk })
  })

  it('does not bill the states quota counts before a box is usable', () => {
    // quota counts CREATING/STARTING because the runner has already pinned the
    // resources; billing deliberately does not charge for a box the tenant
    // cannot use yet. Divergence here is a pricing decision, not a bug.
    const notYetBillable = [BoxState.CREATING, BoxState.STARTING, BoxState.RESTORING]

    for (const state of notYetBillable) {
      expect(BOX_STATES_CONSUMING_COMPUTE).toContain(state)
      expect(expectedOpenPeriod({ ...box, state })).toBeNull()
    }
  })
})

describe('sameShape', () => {
  it('accepts a period that already charges the right resources', () => {
    expect(sameShape(FULL_COMPUTE, FULL_COMPUTE)).toBe(true)
  })

  it.each(['cpu', 'gpu', 'mem', 'disk'] as const)('rejects a period whose %s differs', (resource) => {
    expect(sameShape({ ...FULL_COMPUTE, [resource]: FULL_COMPUTE[resource] + 1 }, FULL_COMPUTE)).toBe(false)
  })

  it('tolerates an immaterial fractional difference in a period row', () => {
    // Box resources are integers, but period resources are double precision;
    // avoid needlessly splitting a period whose fractional difference is immaterial.
    expect(sameShape({ ...FULL_COMPUTE, cpu: FULL_COMPUTE.cpu + 5e-7 }, FULL_COMPUTE)).toBe(true)
  })

  it('still rejects a difference larger than that tolerance', () => {
    expect(sameShape({ ...FULL_COMPUTE, cpu: FULL_COMPUTE.cpu + 1e-4 }, FULL_COMPUTE)).toBe(false)
  })
})
