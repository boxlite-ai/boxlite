/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryFailedError } from 'typeorm'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { RatingService } from './rating.service'

class FakeQueryBuilder<T> {
  constructor(private readonly rows: T[]) {}

  leftJoin() {
    return this
  }

  where() {
    return this
  }

  andWhere() {
    return this
  }

  orderBy() {
    return this
  }

  take() {
    return this
  }

  async getMany(): Promise<T[]> {
    return this.rows
  }
}

class FakeUsageArchiveRepository {
  rows: BoxUsagePeriodArchive[] = []

  createQueryBuilder() {
    return new FakeQueryBuilder(this.rows)
  }
}

class FakePricingPlanRepository {
  rows: PricingPlan[] = []

  createQueryBuilder() {
    return new FakeQueryBuilder(this.rows)
  }
}

class FakeRatedPeriodRepository {
  rows: RatedPeriod[] = []
  saveError: Error | null = null

  create(input: Partial<RatedPeriod>): RatedPeriod {
    return input as RatedPeriod
  }

  async save(row: RatedPeriod): Promise<RatedPeriod> {
    if (this.saveError) {
      throw this.saveError
    }
    if (this.rows.some((existing) => existing.usagePeriodArchiveId === row.usagePeriodArchiveId)) {
      throw uniqueViolation()
    }
    row.id = row.id ?? `rated-${this.rows.length + 1}`
    this.rows.push(row)
    return row
  }
}

function uniqueViolation(): QueryFailedError {
  return new QueryFailedError('INSERT INTO rated_period', [], Object.assign(new Error('duplicate'), { code: '23505' }))
}

function archivedPeriod(overrides: Partial<BoxUsagePeriodArchive> = {}): BoxUsagePeriodArchive {
  return {
    id: 'b3fbf3a8-0c33-4962-bd77-8ae77313baf1',
    boxId: 'box-1',
    organizationId: 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0',
    region: 'us',
    startAt: new Date('2026-07-08T00:00:00Z'),
    endAt: new Date('2026-07-08T00:01:00Z'),
    cpu: 2,
    mem: 4,
    disk: 10,
    gpu: 1,
    ...overrides,
  } as BoxUsagePeriodArchive
}

function pricingPlan(overrides: Partial<PricingPlan> = {}): PricingPlan {
  return {
    id: 'd4624b9b-d5d7-471c-9dce-f1e96ab0ab47',
    version: 1,
    cpuRateCentsPerSec: '2',
    memRateCentsPerSec: '1',
    diskRateCentsPerSec: '0.5',
    gpuRateCentsPerSec: '10',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as PricingPlan
}

function createService() {
  const usageArchives = new FakeUsageArchiveRepository()
  const ratedPeriods = new FakeRatedPeriodRepository()
  const pricingPlans = new FakePricingPlanRepository()
  const service = new RatingService(usageArchives as never, ratedPeriods as never, pricingPlans as never)
  return { service, usageArchives, ratedPeriods, pricingPlans }
}

describe('RatingService', () => {
  it('rates an archived usage period exactly once and stores immutable segment snapshots', async () => {
    const { service, usageArchives, ratedPeriods, pricingPlans } = createService()
    usageArchives.rows.push(archivedPeriod())
    pricingPlans.rows.push(pricingPlan())

    expect(await service.rateClosedPeriods()).toEqual({ rated: 1, skipped: 0 })
    expect(await service.rateClosedPeriods()).toEqual({ rated: 0, skipped: 1 })
    expect(ratedPeriods.rows).toHaveLength(1)
    expect(ratedPeriods.rows[0]).toMatchObject({
      usagePeriodArchiveId: 'b3fbf3a8-0c33-4962-bd77-8ae77313baf1',
      organizationId: 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0',
      boxId: 'box-1',
      billedSeconds: '60',
      preciseCents: '1380',
      ratedCents: '1380',
      pricingSegments: [{ pricingVersion: 1 }],
    })
  })

  it('stores both price snapshots when a usage period crosses an effective boundary', async () => {
    const { service, usageArchives, ratedPeriods, pricingPlans } = createService()
    const boundary = new Date('2026-07-08T00:00:30Z')
    usageArchives.rows.push(archivedPeriod({ cpu: 1, mem: 0, disk: 0, gpu: 0 }))
    pricingPlans.rows.push(
      pricingPlan({ cpuRateCentsPerSec: '0.01', effectiveTo: boundary }),
      pricingPlan({
        id: 'f838ba1d-ef3c-45ab-a036-af916da6d0d2',
        version: 2,
        cpuRateCentsPerSec: '0.02',
        effectiveFrom: boundary,
      }),
    )

    await service.rateClosedPeriods()

    expect(ratedPeriods.rows[0]).toMatchObject({
      preciseCents: '0.9',
      ratedCents: '1',
      pricingSegments: [{ pricingVersion: 1 }, { pricingVersion: 2 }],
    })
  })

  it('fails on a pricing gap without mutating the usage archive', async () => {
    const { service, usageArchives, ratedPeriods, pricingPlans } = createService()
    const source = archivedPeriod()
    const sourceBefore = { ...source }
    usageArchives.rows.push(source)
    pricingPlans.rows.push(pricingPlan({ effectiveTo: new Date('2026-07-08T00:00:20Z') }))

    await expect(service.rateClosedPeriods()).rejects.toThrow('pricing gap')
    expect(ratedPeriods.rows).toHaveLength(0)
    expect(source).toEqual(sourceBefore)
  })

  it('treats a PostgreSQL unique violation as an idempotent skip', async () => {
    const { service, usageArchives, ratedPeriods, pricingPlans } = createService()
    usageArchives.rows.push(archivedPeriod())
    pricingPlans.rows.push(pricingPlan())
    ratedPeriods.saveError = uniqueViolation()

    expect(await service.rateClosedPeriods()).toEqual({ rated: 0, skipped: 1 })
  })

  it('propagates unrelated persistence failures', async () => {
    const { service, usageArchives, ratedPeriods, pricingPlans } = createService()
    usageArchives.rows.push(archivedPeriod())
    pricingPlans.rows.push(pricingPlan())
    ratedPeriods.saveError = new Error('database unavailable')

    await expect(service.rateClosedPeriods()).rejects.toThrow('database unavailable')
  })
})
