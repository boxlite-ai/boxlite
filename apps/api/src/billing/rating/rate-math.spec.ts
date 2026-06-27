/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UsageTotals } from '../../usage/billing/usage-math'
import { computeRatedCents, resolveRateSnapshot, RateSnapshot } from './rate-math'

const totals = (cpu: number, ram: number, disk: number): UsageTotals => ({
  totalCpuSeconds: cpu,
  totalRamGbSeconds: ram,
  totalDiskGbSeconds: disk,
})

describe('resolveRateSnapshot', () => {
  const plan = { cpuRateCentsPerSec: '2', memRateCentsPerSec: '1', diskRateCentsPerSec: '0.5' }

  it('uses plan list rates at factor 1 when there is no override', () => {
    expect(resolveRateSnapshot(plan)).toEqual({
      cpuRateCentsPerSec: '2',
      memRateCentsPerSec: '1',
      diskRateCentsPerSec: '0.5',
      discountFactor: '1',
    })
  })

  it('applies a discount factor while keeping plan rates', () => {
    expect(resolveRateSnapshot(plan, { discountFactor: '0.85', effectiveRates: null }).discountFactor).toBe('0.85')
  })

  it('lets effectiveRates fully override the plan rates', () => {
    const snap = resolveRateSnapshot(plan, {
      discountFactor: null,
      effectiveRates: { cpu: '5', mem: '4', disk: '3' },
    })
    expect(snap).toEqual({
      cpuRateCentsPerSec: '5',
      memRateCentsPerSec: '4',
      diskRateCentsPerSec: '3',
      discountFactor: '1',
    })
  })
})

describe('computeRatedCents', () => {
  const snap = (cpu: string, mem: string, disk: string, discount = '1'): RateSnapshot => ({
    cpuRateCentsPerSec: cpu,
    memRateCentsPerSec: mem,
    diskRateCentsPerSec: disk,
    discountFactor: discount,
  })

  it('sums all three dimensions × their rates', () => {
    // 10s×2 + 20s×1 + 100s×0.5 = 20 + 20 + 50 = 90 cents
    const r = computeRatedCents(totals(10, 20, 100), snap('2', '1', '0.5'))
    expect(r.ratedCents).toBe(90)
    expect(r.preciseCents).toBe('90')
  })

  it('applies the discount factor to the total', () => {
    // 90 × 0.5 = 45
    expect(computeRatedCents(totals(10, 20, 100), snap('2', '1', '0.5', '0.5')).ratedCents).toBe(45)
  })

  it('keeps sub-cent precision while accumulating, only rounding at the end', () => {
    // rate 0.0001 cents/sec × 10000s = 1.0 cent exactly — a float would drift.
    const r = computeRatedCents(totals(10000, 0, 0), snap('0.0001', '0', '0'))
    expect(r.preciseCents).toBe('1')
    expect(r.ratedCents).toBe(1)
  })

  it('rounds half-up at the cent boundary (0.4 down, 0.6 up)', () => {
    expect(computeRatedCents(totals(1, 0, 0), snap('20.4', '0', '0')).ratedCents).toBe(20)
    expect(computeRatedCents(totals(1, 0, 0), snap('20.6', '0', '0')).ratedCents).toBe(21)
    expect(computeRatedCents(totals(1, 0, 0), snap('20.5', '0', '0')).ratedCents).toBe(21)
  })

  it('preserves the sub-cent precise value separately from the billed cents', () => {
    const r = computeRatedCents(totals(3, 0, 0), snap('0.333', '0', '0'))
    expect(r.preciseCents).toBe('0.999')
    expect(r.ratedCents).toBe(1)
  })

  it('a zero-usage period rates to 0', () => {
    expect(computeRatedCents(totals(0, 0, 0), snap('2', '1', '0.5'))).toEqual({ preciseCents: '0', ratedCents: 0 })
  })
})
