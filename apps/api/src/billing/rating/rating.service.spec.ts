/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryFailedError, Repository } from 'typeorm'
import { UsagePeriod } from '../../usage/entities/usage-period.entity'
import { CustomerRateOverride } from '../entities/customer-rate-override.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { RatingService } from './rating.service'

/** Minimal chainable query-builder mock whose terminal calls return canned data. */
function qb(result: unknown) {
  const self: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'where', 'andWhere', 'orderBy']) self[m] = () => self
  self.getOne = async () => result
  self.getMany = async () => result
  return self
}

const PLAN: PricingPlan = {
  id: 'plan-1',
  version: 3,
  cpuRateCentsPerSec: '2',
  memRateCentsPerSec: '1',
  diskRateCentsPerSec: '0.5',
  warnThresholdCents: '500',
  defaultGrantCents: '0',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  createdBy: 'seed',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

const PERIOD: UsagePeriod = {
  id: 'up-1',
  boxId: 'box-1',
  organizationId: 'org-1',
  region: 'us',
  periodStart: new Date('2026-06-27T00:00:00Z'),
  periodEnd: new Date('2026-06-27T00:01:00Z'), // 60s running
  kind: 'running',
  allocCpu: 2,
  allocMemGib: 4,
  allocDiskGib: 10,
} as UsagePeriod

function makeService(opts: {
  plan?: PricingPlan | null
  override?: CustomerRateOverride | null
  save?: jest.Mock
  unrated?: UsagePeriod[]
}) {
  const saveMock = opts.save ?? jest.fn(async (r) => ({ id: 'rated-1', ...r }))
  const ratedPeriods = {
    create: (r: Partial<RatedPeriod>) => r,
    save: saveMock,
    createQueryBuilder: () => qb(opts.unrated ?? []),
  } as unknown as Repository<RatedPeriod>
  const usagePeriods = { createQueryBuilder: () => qb(opts.unrated ?? []) } as unknown as Repository<UsagePeriod>
  const plans = {
    createQueryBuilder: () => qb(opts.plan === undefined ? PLAN : opts.plan),
  } as unknown as Repository<PricingPlan>
  const overrides = {
    createQueryBuilder: () => qb(opts.override ?? null),
  } as unknown as Repository<CustomerRateOverride>

  return { service: new RatingService(usagePeriods, ratedPeriods, plans, overrides), saveMock }
}

describe('RatingService.ratePeriod', () => {
  it('rates a running period and freezes the rate snapshot onto the row', async () => {
    const { service, saveMock } = makeService({})
    const row = await service.ratePeriod(PERIOD)

    // 60s × (2cpu×2 + 4ram×1 + 10disk×0.5) = 60 × (4 + 4 + 5) = 60 × 13 = 780
    expect(saveMock).toHaveBeenCalledTimes(1)
    const saved = saveMock.mock.calls[0][0]
    expect(saved.ratedCents).toBe('780')
    expect(saved.billedSeconds).toBe('60')
    expect(saved.pricingVersion).toBe(3)
    expect(saved.unitRates).toEqual({
      cpuRateCentsPerSec: '2',
      memRateCentsPerSec: '1',
      diskRateCentsPerSec: '0.5',
      discountFactor: '1',
    })
    expect(row).not.toBeNull()
  })

  it('applies a per-customer discount when an override is active', async () => {
    const override = { discountFactor: '0.5', effectiveRates: null } as CustomerRateOverride
    const { service, saveMock } = makeService({ override })
    await service.ratePeriod(PERIOD)
    expect(saveMock.mock.calls[0][0].ratedCents).toBe('390') // 780 × 0.5
    expect(saveMock.mock.calls[0][0].unitRates.discountFactor).toBe('0.5')
  })

  it('is idempotent: a duplicate (UNIQUE violation) save returns null, not an error', async () => {
    const save = jest.fn(async () => {
      throw new QueryFailedError('insert', [], { code: '23505' } as unknown as Error)
    })
    const { service } = makeService({ save })
    await expect(service.ratePeriod(PERIOD)).resolves.toBeNull()
  })

  it('rethrows non-unique DB errors', async () => {
    const save = jest.fn(async () => {
      throw new QueryFailedError('insert', [], { code: '23502' } as unknown as Error) // not-null violation
    })
    const { service } = makeService({ save })
    await expect(service.ratePeriod(PERIOD)).rejects.toBeInstanceOf(QueryFailedError)
  })

  it('skips a period with no effective pricing plan', async () => {
    const { service, saveMock } = makeService({ plan: null })
    expect(await service.ratePeriod(PERIOD)).toBeNull()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('skips a still-open period (no periodEnd)', async () => {
    const { service, saveMock } = makeService({})
    expect(await service.ratePeriod({ ...PERIOD, periodEnd: null } as UsagePeriod)).toBeNull()
    expect(saveMock).not.toHaveBeenCalled()
  })
})

describe('RatingService.rateClosedPeriods', () => {
  it('counts rated vs skipped across the work list', async () => {
    const { service, saveMock } = makeService({ unrated: [PERIOD, { ...PERIOD, id: 'up-2' } as UsagePeriod] })
    const result = await service.rateClosedPeriods()
    expect(result).toEqual({ rated: 2, skipped: 0 })
    expect(saveMock).toHaveBeenCalledTimes(2)
  })
})
