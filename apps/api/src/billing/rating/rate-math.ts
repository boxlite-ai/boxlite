/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Decimal from 'decimal.js'
import { UsageTotals } from '../../usage/billing/usage-math'

/**
 * Pure rating math — turns Phase 1's raw usage totals (CPU/RAM/Disk seconds)
 * into a USD amount, with sub-cent precision and a version-frozen rate snapshot.
 *
 * Grounded in OpenMeter `SnapshotLineQuantity` (freeze the rate onto the rated
 * row) + Lago `precise_amount_cents decimal(30,5)` (accumulate in Decimal, round
 * to whole cents only at the boundary). No DB, no I/O — deterministic and
 * unit-testable. The control-plane service freezes the returned snapshot onto
 * `rated_period.unit_rates`; reads never re-join the live plan, so changing a
 * price never moves a historical bill (canon I7).
 */

/** A frozen, per-second rate (cents per unit-second) for one rating event. */
export interface RateSnapshot {
  /** Cents per vCPU-second (may be fractional, kept as a decimal string). */
  cpuRateCentsPerSec: string
  /** Cents per GiB-second. */
  memRateCentsPerSec: string
  /** Cents per GiB-second. */
  diskRateCentsPerSec: string
  /** Multiplier, "1" = list price, "0.85" = 15% off. */
  discountFactor: string
}

/** A pricing-plan version (already selected for the usage moment by the caller). */
export interface PricingPlanLike {
  cpuRateCentsPerSec: string
  memRateCentsPerSec: string
  diskRateCentsPerSec: string
}

/** A per-customer rate override (optional). `effectiveRates` beats `discountFactor`. */
export interface RateOverrideLike {
  discountFactor: string | null
  effectiveRates: { cpu: string; mem: string; disk: string } | null
}

/** Result of rating one usage period: a sub-cent precise value + the billed (rounded) cents. */
export interface RatedAmount {
  /** Sub-cent precise value as a decimal string (what we persist to keep accumulation honest). */
  preciseCents: string
  /** Whole cents actually billed (round-half-up of `preciseCents`). */
  ratedCents: number
}

/**
 * Build the frozen rate snapshot for a usage moment: a per-customer override (if
 * present) replaces the rates and/or applies a discount; otherwise the plan's
 * list rates at factor 1. The caller selects which plan *version* applies (by
 * `effective_from <= usageStart < effective_to`); this function just composes
 * the final per-second rates so they can be frozen onto the rated row.
 */
export function resolveRateSnapshot(plan: PricingPlanLike, override?: RateOverrideLike | null): RateSnapshot {
  const rates = override?.effectiveRates
    ? { cpu: override.effectiveRates.cpu, mem: override.effectiveRates.mem, disk: override.effectiveRates.disk }
    : { cpu: plan.cpuRateCentsPerSec, mem: plan.memRateCentsPerSec, disk: plan.diskRateCentsPerSec }

  return {
    cpuRateCentsPerSec: rates.cpu,
    memRateCentsPerSec: rates.mem,
    diskRateCentsPerSec: rates.disk,
    discountFactor: override?.discountFactor ?? '1',
  }
}

/**
 * Rate a usage period: `Σ_dim (seconds_dim × rate_dim) × discount`, accumulated
 * in Decimal so per-second sub-cent amounts never lose precision, then rounded
 * half-up to whole cents at the very end.
 */
export function computeRatedCents(totals: UsageTotals, snap: RateSnapshot): RatedAmount {
  const cpu = new Decimal(totals.totalCpuSeconds).times(snap.cpuRateCentsPerSec)
  const mem = new Decimal(totals.totalRamGbSeconds).times(snap.memRateCentsPerSec)
  const disk = new Decimal(totals.totalDiskGbSeconds).times(snap.diskRateCentsPerSec)

  const precise = cpu.plus(mem).plus(disk).times(snap.discountFactor)
  const rounded = precise.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)

  return {
    preciseCents: precise.toString(),
    ratedCents: rounded.toNumber(),
  }
}

/** One closed Phase-1 usage period, just the fields rating needs. */
export interface ClosedPeriodLike {
  periodStart: Date
  periodEnd: Date
  /** `running` (cpu+ram+disk) or `stopped` (disk only) — matches Phase 1 aggregatePeriods. */
  kind: string
  allocCpu: number
  allocMemGib: number
  allocDiskGib: number
}

/**
 * Turn one closed usage period into billable totals: disk is charged whether the
 * box was running or stopped; CPU and RAM only while running (the same split
 * Phase 1 uses to aggregate). `billedSeconds` is the wall-clock span.
 */
export function periodBillableTotals(period: ClosedPeriodLike): { totals: UsageTotals; billedSeconds: number } {
  const billedSeconds = Math.max(0, (period.periodEnd.getTime() - period.periodStart.getTime()) / 1000)
  const running = period.kind === 'running'
  return {
    billedSeconds,
    totals: {
      totalCpuSeconds: running ? period.allocCpu * billedSeconds : 0,
      totalRamGbSeconds: running ? period.allocMemGib * billedSeconds : 0,
      totalDiskGbSeconds: period.allocDiskGib * billedSeconds,
    },
  }
}
