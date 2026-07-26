/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'

/**
 * Billing meaning of a box lifecycle state.
 *
 * - `running`  — CPU + RAM + Disk all bill (box is executing).
 * - `stopped`  — only Disk bills (box exists on disk but isn't running:
 *                stopped / archived / starting / etc.).
 * - `gone`     — box destroyed; no period exists (close any open one).
 */
export type BillingPeriodKind = 'running' | 'stopped' | 'gone'

/**
 * Map a {@link BoxState} to its billing meaning (the §8 truth table, collapsed
 * to the control-plane's view — note there is no `paused` state at the API
 * level). CPU/RAM bind to `running`; Disk binds to existence (everything except
 * `gone`).
 */
export function billingPeriodKind(state: BoxState): BillingPeriodKind {
  switch (state) {
    case BoxState.STARTED:
      return 'running'
    case BoxState.DESTROYED:
    case BoxState.DESTROYING:
      return 'gone'
    default:
      // creating / restoring / starting / stopping / stopped / error /
      // unknown / archived / archiving: rootfs exists → Disk bills,
      // but CPU/RAM do not (box isn't executing).
      return 'stopped'
  }
}

/** What to do to the period ledger when a box changes state. */
export interface TransitionPlan {
  /** Close the currently-open period (stamp its `endAt = now`). */
  closeOpen: boolean
  /** Open a fresh period of this kind, or `null` to open nothing. */
  openKind: 'running' | 'stopped' | null
}

/**
 * Decide how the open period should change when a box moves to `newState`,
 * given the kind of the currently-open period (`null` = none open).
 *
 * Keeps segments clean without churn: a transition that doesn't change the
 * billing kind (e.g. STARTED→STARTED, or two disk-only states) is a no-op, so
 * one continuous period is kept rather than fragmenting the ledger.
 */
export function planTransition(openKind: 'running' | 'stopped' | null, newState: BoxState): TransitionPlan {
  // RESIZING is a transient in-place state: a resize can start from STARTED
  // (hot — workload keeps executing) or STOPPED (disk resize), and the box
  // returns to that state when it completes. Mapping it to either kind would
  // mis-bill one of the two cases (close a still-running period, or bill
  // CPU/RAM for a stopped box), so the ledger simply keeps the open period.
  if (newState === BoxState.RESIZING) {
    return { closeOpen: false, openKind: null }
  }

  const kind = billingPeriodKind(newState)

  if (kind === 'gone') {
    // Box destroyed: close whatever is open, open nothing.
    return { closeOpen: openKind !== null, openKind: null }
  }

  // Same billing kind → keep the single open period (no churn).
  if (openKind === kind) {
    return { closeOpen: false, openKind: null }
  }

  // Kind changed: close the old open period (if any) and open the new kind.
  return { closeOpen: openKind !== null, openKind: kind }
}

/** A stored usage period (alloc side) that contributes to billing. */
export interface BillablePeriod {
  startAt: Date
  /** `null` = period still open (box still in this state). */
  endAt: Date | null
  /** `running`: cpu+ram+disk bill; `stopped`: disk only. */
  kind: 'running' | 'stopped'
  allocCpu: number
  allocMemGib: number
  allocDiskGib: number
}

/** Aggregated billable quantities over a time range (matches the analytics
 *  contract's `totalCPUSeconds` / `totalRAMGBSeconds` / `totalDiskGBSeconds`). */
export interface UsageTotals {
  totalCpuSeconds: number
  totalRamGbSeconds: number
  totalDiskGbSeconds: number
}

/**
 * Aggregate periods into billable totals, clipping each period to `[from, to]`.
 * Open periods (`endAt === null`) are clipped at `to`. CPU/RAM only accrue for
 * `running` periods; Disk accrues for every (existing) period.
 */
export function aggregatePeriods(periods: BillablePeriod[], from: Date, to: Date): UsageTotals {
  const fromMs = from.getTime()
  const toMs = to.getTime()

  let totalCpuSeconds = 0
  let totalRamGbSeconds = 0
  let totalDiskGbSeconds = 0

  for (const p of periods) {
    // Open periods are clipped at the range end.
    const endMs = (p.endAt ?? to).getTime()
    const overlapStart = Math.max(p.startAt.getTime(), fromMs)
    const overlapEnd = Math.min(endMs, toMs)
    if (overlapEnd <= overlapStart) {
      continue // entirely outside [from, to]
    }
    const seconds = (overlapEnd - overlapStart) / 1000

    // Disk binds to existence — every (existing) period contributes.
    totalDiskGbSeconds += p.allocDiskGib * seconds
    // CPU/RAM bind to running.
    if (p.kind === 'running') {
      totalCpuSeconds += p.allocCpu * seconds
      totalRamGbSeconds += p.allocMemGib * seconds
    }
  }

  return { totalCpuSeconds, totalRamGbSeconds, totalDiskGbSeconds }
}
