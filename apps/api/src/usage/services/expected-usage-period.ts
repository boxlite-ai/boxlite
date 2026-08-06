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

/** Stable states which must have an open period. */
export const BOX_STATES_WITH_OPEN_PERIOD: BoxState[] = [BoxState.STARTED, BoxState.STOPPING, BoxState.STOPPED]

/** Terminal states which must not have an open period. */
export const BOX_STATES_WITHOUT_OPEN_PERIOD: BoxState[] = [
  BoxState.ERROR,
  BoxState.ARCHIVED,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
]

/** States which keep paying for disk but no longer pay for compute. */
export const BOX_STATES_BILLING_DISK_ONLY: BoxState[] = [BoxState.STOPPING, BoxState.STOPPED]

// Both tables use double precision. A tolerance prevents a harmless Postgres
// round-trip difference from fragmenting the ledger on every reconcile pass.
export const RESOURCE_EPSILON = 1e-6

/**
 * Returns the open-period shape for a stable box state.
 *
 * This deliberately differs from quota accounting: quota may reserve compute
 * while a box is starting, but billing does not charge until it is usable.
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

/** Whether a period already charges the expected resources. */
export function sameShape(period: UsagePeriodShape, expected: UsagePeriodShape): boolean {
  return (['cpu', 'gpu', 'mem', 'disk'] as const).every(
    (resource) => Math.abs(period[resource] - expected[resource]) < RESOURCE_EPSILON,
  )
}
