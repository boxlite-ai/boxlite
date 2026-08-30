/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'

/** The resources an open usage period charges for. */
export interface UsagePeriodShape {
  cpu: number
  gpu: number
  mem: number
  disk: number
}

/** The box fields that decide what its open period should charge. */
export interface BillableBox extends UsagePeriodShape {
  state: BoxState
}

export type ExpectedOpenPeriod = UsagePeriodShape | null

/** States that must have an open period. */
export const BOX_STATES_WITH_OPEN_PERIOD: BoxState[] = [BoxState.STARTED, BoxState.STOPPING, BoxState.STOPPED]

/** States that must not have one — the box has stopped consuming anything. */
export const BOX_STATES_WITHOUT_OPEN_PERIOD: BoxState[] = [
  BoxState.ERROR,
  BoxState.ARCHIVED,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
]

/** Of the states above, the ones that keep paying for disk but not compute. */
export const BOX_STATES_BILLING_DISK_ONLY: BoxState[] = [BoxState.STOPPING, BoxState.STOPPED]

// Every remaining state is in neither list and bills nothing, the same answer a
// terminal box gets: CREATING, STARTING and UNKNOWN, plus RESTORING, RESIZING
// and ARCHIVING, which no writer in this repository ever assigns.
//
// Answering "nothing" rather than "leave whatever is there alone" is safe
// because the only caller that acts on that answer destructively is the
// reconcile pass, and its candidate query is restricted to the two lists above,
// so it is never handed a box mid-transition. The one way it can see one is a
// box whose state moved between the scan and the repair — and there the period
// it would close is a drifted one it was picked up to correct anyway.

// Box resources are integers, while usage-period resources are double
// precision. Normal writes therefore compare exactly; this tolerance is a
// defensive guard for non-canonical period rows, preventing an immaterial
// fractional difference from causing an unnecessary close/reopen split.
const RESOURCE_EPSILON = 1e-6

/**
 * What the box's open usage period should charge, given the state it is in
 * right now: full compute while running, disk alone once it has stopped, and
 * nothing at all otherwise.
 *
 * This is the single source of truth for the state -> period rule, shared by
 * the event handler, the daily roll-over and the reconcile pass. Transitional
 * states do not open a period because billing does not charge for a box the
 * tenant cannot use yet.
 */
export function expectedOpenPeriod(box: BillableBox | null | undefined): ExpectedOpenPeriod {
  if (!box) {
    return null
  }
  if (box.state === BoxState.STARTED) {
    return { cpu: box.cpu, gpu: box.gpu, mem: box.mem, disk: box.disk }
  }
  if (BOX_STATES_BILLING_DISK_ONLY.includes(box.state)) {
    return { cpu: 0, gpu: 0, mem: 0, disk: box.disk }
  }
  return null
}

/** Whether a period already charges what it should, within resource tolerance. */
export function sameShape(period: UsagePeriodShape, expected: UsagePeriodShape): boolean {
  return (['cpu', 'gpu', 'mem', 'disk'] as const).every(
    (resource) => Math.abs(period[resource] - expected[resource]) < RESOURCE_EPSILON,
  )
}
