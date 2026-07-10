/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  computeRatedCents,
  periodBillableTotals,
  ratePeriodByPlans,
  type PricingPlanSnapshot,
  type RateSnapshot,
  type RateableUsagePeriod,
} from './rate-math'

const period = (overrides: Partial<RateableUsagePeriod> = {}): RateableUsagePeriod => ({
  startAt: new Date('2026-07-08T00:00:00Z'),
  endAt: new Date('2026-07-08T00:01:00Z'),
  cpu: 2,
  mem: 4,
  disk: 10,
  gpu: 1,
  ...overrides,
})

const rates = (overrides: Partial<RateSnapshot> = {}): RateSnapshot => ({
  cpuRateCentsPerSec: '2',
  memRateCentsPerSec: '1',
  diskRateCentsPerSec: '0.5',
  gpuRateCentsPerSec: '10',
  ...overrides,
})

const plan = (overrides: Partial<PricingPlanSnapshot> = {}): PricingPlanSnapshot => ({
  version: 1,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...rates(),
  ...overrides,
})

describe('periodBillableTotals', () => {
  it('uses every stored resource dimension for the exact elapsed seconds', () => {
    expect(periodBillableTotals(period())).toEqual({
      billedSeconds: '60',
      usageTotals: {
        cpuSeconds: '120',
        memGibSeconds: '240',
        diskGibSeconds: '600',
        gpuSeconds: '60',
      },
    })
  })

  it('charges only disk when the archived row stores zero running resources', () => {
    expect(periodBillableTotals(period({ cpu: 0, mem: 0, gpu: 0 }))).toEqual({
      billedSeconds: '60',
      usageTotals: {
        cpuSeconds: '0',
        memGibSeconds: '0',
        diskGibSeconds: '600',
        gpuSeconds: '0',
      },
    })
  })
})

describe('computeRatedCents', () => {
  it('keeps sub-cent precision and rounds the final cents half-up', () => {
    expect(
      computeRatedCents(
        {
          cpuSeconds: '1',
          memGibSeconds: '1',
          diskGibSeconds: '1',
          gpuSeconds: '0',
        },
        rates({
          cpuRateCentsPerSec: '0.1',
          memRateCentsPerSec: '0.2',
          diskRateCentsPerSec: '0.2',
          gpuRateCentsPerSec: '0',
        }),
      ),
    ).toEqual({ preciseCents: '0.5', ratedCents: '1' })
  })

  it('rejects negative rates instead of turning usage into wallet credit', () => {
    expect(() =>
      computeRatedCents(
        {
          cpuSeconds: '1',
          memGibSeconds: '0',
          diskGibSeconds: '0',
          gpuSeconds: '0',
        },
        rates({ cpuRateCentsPerSec: '-1' }),
      ),
    ).toThrow('cpu rate must be non-negative')
  })
})

describe('ratePeriodByPlans', () => {
  it('snapshots one price version for a period inside one effective interval', () => {
    const result = ratePeriodByPlans(period(), [plan()])

    expect(result).toMatchObject({
      billedSeconds: '60',
      preciseCents: '1380',
      ratedCents: '1380',
      pricingSegments: [
        {
          pricingVersion: 1,
          startAt: '2026-07-08T00:00:00.000Z',
          endAt: '2026-07-08T00:01:00.000Z',
          billedSeconds: '60',
          unitRates: rates(),
          preciseCents: '1380',
        },
      ],
    })
  })

  it('splits a period at a pricing boundary and rounds only the aggregate charge', () => {
    const boundary = new Date('2026-07-08T00:00:30Z')
    const result = ratePeriodByPlans(period({ cpu: 1, mem: 0, disk: 0, gpu: 0 }), [
      plan({
        version: 1,
        cpuRateCentsPerSec: '0.01',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveTo: boundary,
      }),
      plan({
        version: 2,
        cpuRateCentsPerSec: '0.02',
        memRateCentsPerSec: '0',
        diskRateCentsPerSec: '0',
        gpuRateCentsPerSec: '0',
        effectiveFrom: boundary,
      }),
    ])

    expect(result.pricingSegments).toHaveLength(2)
    expect(result.pricingSegments.map((segment) => segment.pricingVersion)).toEqual([1, 2])
    expect(result.pricingSegments.map((segment) => segment.preciseCents)).toEqual(['0.3', '0.6'])
    expect(result).toMatchObject({ billedSeconds: '60', preciseCents: '0.9', ratedCents: '1' })
  })

  it('rejects an uncovered interval instead of silently undercharging', () => {
    expect(() =>
      ratePeriodByPlans(period(), [
        plan({ effectiveTo: new Date('2026-07-08T00:00:20Z') }),
        plan({ version: 2, effectiveFrom: new Date('2026-07-08T00:00:30Z') }),
      ]),
    ).toThrow('pricing gap')
  })

  it('rejects overlapping price versions instead of choosing one arbitrarily', () => {
    expect(() =>
      ratePeriodByPlans(period(), [
        plan({ effectiveTo: new Date('2026-07-08T00:00:40Z') }),
        plan({ version: 2, effectiveFrom: new Date('2026-07-08T00:00:30Z') }),
      ]),
    ).toThrow('pricing overlap')
  })
})
