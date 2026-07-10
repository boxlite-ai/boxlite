/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Decimal from 'decimal.js'

export interface UsageTotals {
  cpuSeconds: string
  memGibSeconds: string
  diskGibSeconds: string
  gpuSeconds: string
}

export interface RateSnapshot {
  cpuRateCentsPerSec: string
  memRateCentsPerSec: string
  diskRateCentsPerSec: string
  gpuRateCentsPerSec: string
}

export interface PricingPlanSnapshot extends RateSnapshot {
  version: number
  effectiveFrom: Date
  effectiveTo: Date | null
}

export interface RateableUsagePeriod {
  startAt: Date
  endAt: Date
  cpu: number
  mem: number
  disk: number
  gpu: number
}

export interface PricingSegment {
  pricingVersion: number
  startAt: string
  endAt: string
  billedSeconds: string
  unitRates: RateSnapshot
  usageTotals: UsageTotals
  preciseCents: string
}

export interface RatedPeriodComputation {
  pricingSegments: PricingSegment[]
  billedSeconds: string
  usageTotals: UsageTotals
  preciseCents: string
  ratedCents: string
}

const ZERO_TOTALS: UsageTotals = {
  cpuSeconds: '0',
  memGibSeconds: '0',
  diskGibSeconds: '0',
  gpuSeconds: '0',
}

function elapsedSeconds(startAt: Date, endAt: Date): Decimal {
  const milliseconds = endAt.getTime() - startAt.getTime()
  if (milliseconds < 0) {
    throw new Error(`usage period ends before it starts: ${startAt.toISOString()} - ${endAt.toISOString()}`)
  }
  return new Decimal(milliseconds).div(1000)
}

function decimalResource(value: number, name: string): Decimal {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
  return new Decimal(value.toString())
}

function decimalRate(value: string, name: string): Decimal {
  const rate = new Decimal(value)
  if (rate.isNegative()) {
    throw new Error(`${name} rate must be non-negative`)
  }
  return rate
}

function snapshotRates(plan: PricingPlanSnapshot): RateSnapshot {
  return {
    cpuRateCentsPerSec: plan.cpuRateCentsPerSec,
    memRateCentsPerSec: plan.memRateCentsPerSec,
    diskRateCentsPerSec: plan.diskRateCentsPerSec,
    gpuRateCentsPerSec: plan.gpuRateCentsPerSec,
  }
}

function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    cpuSeconds: new Decimal(left.cpuSeconds).plus(right.cpuSeconds).toString(),
    memGibSeconds: new Decimal(left.memGibSeconds).plus(right.memGibSeconds).toString(),
    diskGibSeconds: new Decimal(left.diskGibSeconds).plus(right.diskGibSeconds).toString(),
    gpuSeconds: new Decimal(left.gpuSeconds).plus(right.gpuSeconds).toString(),
  }
}

export function periodBillableTotals(
  period: RateableUsagePeriod,
  startAt = period.startAt,
  endAt = period.endAt,
): { billedSeconds: string; usageTotals: UsageTotals } {
  const seconds = elapsedSeconds(startAt, endAt)

  return {
    billedSeconds: seconds.toString(),
    usageTotals: {
      cpuSeconds: decimalResource(period.cpu, 'cpu').mul(seconds).toString(),
      memGibSeconds: decimalResource(period.mem, 'mem').mul(seconds).toString(),
      diskGibSeconds: decimalResource(period.disk, 'disk').mul(seconds).toString(),
      gpuSeconds: decimalResource(period.gpu, 'gpu').mul(seconds).toString(),
    },
  }
}

export function computeRatedCents(
  totals: UsageTotals,
  rates: RateSnapshot,
): { preciseCents: string; ratedCents: string } {
  const preciseCents = new Decimal(totals.cpuSeconds)
    .mul(decimalRate(rates.cpuRateCentsPerSec, 'cpu'))
    .plus(new Decimal(totals.memGibSeconds).mul(decimalRate(rates.memRateCentsPerSec, 'memory')))
    .plus(new Decimal(totals.diskGibSeconds).mul(decimalRate(rates.diskRateCentsPerSec, 'disk')))
    .plus(new Decimal(totals.gpuSeconds).mul(decimalRate(rates.gpuRateCentsPerSec, 'gpu')))

  return {
    preciseCents: preciseCents.toString(),
    ratedCents: preciseCents.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString(),
  }
}

export function ratePeriodByPlans(
  period: RateableUsagePeriod,
  pricingPlans: PricingPlanSnapshot[],
): RatedPeriodComputation {
  const periodStart = period.startAt.getTime()
  const periodEnd = period.endAt.getTime()
  if (periodEnd < periodStart) {
    throw new Error(`usage period ends before it starts: ${period.startAt.toISOString()} - ${period.endAt.toISOString()}`)
  }

  const plans = [...pricingPlans].sort((left, right) => {
    const byStart = left.effectiveFrom.getTime() - right.effectiveFrom.getTime()
    return byStart || left.version - right.version
  })
  let cursor = periodStart
  const segments: PricingSegment[] = []

  while (cursor < periodEnd) {
    const activePlans = plans.filter((plan) => {
      const effectiveFrom = plan.effectiveFrom.getTime()
      const effectiveTo = plan.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY
      return effectiveFrom <= cursor && cursor < effectiveTo
    })

    if (activePlans.length === 0) {
      throw new Error(`pricing gap at ${new Date(cursor).toISOString()}`)
    }
    if (activePlans.length > 1) {
      throw new Error(`pricing overlap at ${new Date(cursor).toISOString()}`)
    }

    const activePlan = activePlans[0]
    const activeEnd = activePlan.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY
    const nextPlanStart = plans
      .map((plan) => plan.effectiveFrom.getTime())
      .filter((effectiveFrom) => effectiveFrom > cursor)
      .reduce((earliest, effectiveFrom) => Math.min(earliest, effectiveFrom), Number.POSITIVE_INFINITY)
    const segmentEnd = Math.min(periodEnd, activeEnd, nextPlanStart)
    if (segmentEnd <= cursor) {
      throw new Error(`pricing interval does not advance at ${new Date(cursor).toISOString()}`)
    }

    const startAt = new Date(cursor)
    const endAt = new Date(segmentEnd)
    const { billedSeconds, usageTotals } = periodBillableTotals(period, startAt, endAt)
    const unitRates = snapshotRates(activePlan)
    const { preciseCents } = computeRatedCents(usageTotals, unitRates)
    segments.push({
      pricingVersion: activePlan.version,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      billedSeconds,
      unitRates,
      usageTotals,
      preciseCents,
    })
    cursor = segmentEnd
  }

  const usageTotals = segments.reduce(
    (totals, segment) => addUsageTotals(totals, segment.usageTotals),
    ZERO_TOTALS,
  )
  const billedSeconds = segments
    .reduce((seconds, segment) => seconds.plus(segment.billedSeconds), new Decimal(0))
    .toString()
  const preciseCents = segments
    .reduce((cents, segment) => cents.plus(segment.preciseCents), new Decimal(0))
    .toString()

  return {
    pricingSegments: segments,
    billedSeconds,
    usageTotals,
    preciseCents,
    ratedCents: new Decimal(preciseCents).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString(),
  }
}
