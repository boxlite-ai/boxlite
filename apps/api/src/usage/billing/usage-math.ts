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
      // unknown / archived / archiving / resizing: rootfs exists → Disk bills,
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

/** What the reconcile sweep needs to know about one stuck open period. */
export interface ReconcileInput {
  /** Kind of the currently-open period. */
  openKind: 'running' | 'stopped'
  periodStart: Date
  /** Current box row, or `null` if the box was deleted. */
  box: { state: BoxState; updatedAt: Date } | null
  /** `false` when the box's runner is unresponsive (box presumed lost). */
  runnerAlive: boolean
  /** Best "last known alive" instant (runner heartbeat), if any. */
  lastAliveAt: Date | null
  now: Date
}

/**
 * Decide whether a stuck open period should be force-closed by the reconcile
 * sweep (and at what timestamp). Returns `null` to leave it open.
 *
 * Force-close when the period can no longer legitimately be open:
 *  1. **runner dead** — box's runner unresponsive; box.state may be stale at
 *     STARTED (the runner-death case neither Daytona nor E2B handle). Close at
 *     the last moment we knew the runner was alive, *not* box.updatedAt (which
 *     could be the box's start → near-zero duration).
 *  2. **box gone** — box row deleted.
 *  3. **box destroyed** — billing kind `gone` (rootfs released).
 *  4. **missed stop** — open `running` period but box no longer running (the
 *     running→stopped close event was lost to an API/DB blip).
 *
 * A legitimately-open `stopped` period (box stopped, disk still billing) is
 * left open — only destroy closes it. Close timestamps are clamped to
 * `[periodStart, now]` so the CHECK constraint can never be violated; closed
 * rows are marked `sealed = false` (suspect) by the caller.
 *
 * Known simplification (safe direction = under-bill, tracked for Phase 1.5):
 * this only ever *closes*. The live path's running→stopped also *opens* a
 * disk-only follow-on; reconcile does not, so for a box that stopped (case 4)
 * but lingers before destroy, the disk between `closeAt` and destroy is billed
 * to nobody. For the runner-dead / box-gone cases the disk is genuinely
 * unreachable, so closing-without-reopening is correct there.
 */
export function planReconcileClose(input: ReconcileInput): { closeAt: Date } | null {
  const { openKind, periodStart, box, runnerAlive, lastAliveAt, now } = input

  const close = (at: Date): { closeAt: Date } => ({
    closeAt: new Date(Math.min(Math.max(at.getTime(), periodStart.getTime()), now.getTime())),
  })

  // 1. Runner dead — trust the last heartbeat over the (possibly stale) box state.
  if (!runnerAlive) {
    return close(lastAliveAt ?? box?.updatedAt ?? now)
  }
  // 2. Box row gone — no better signal than "now".
  if (box === null) {
    return close(lastAliveAt ?? now)
  }
  const kind = billingPeriodKind(box.state)
  // 3. Box destroyed — close at the destroy transition.
  if (kind === 'gone') {
    return close(box.updatedAt)
  }
  // 4. Open running period but box no longer running — missed the close.
  if (openKind === 'running' && kind !== 'running') {
    return close(box.updatedAt)
  }
  // Legitimately open (running box w/ running period, or stopped box w/ disk-only
  // stopped period). Leave it.
  return null
}
