/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { BillingReadService, aggregateRatedPeriods, buildUsageBuckets, parseBillingRange } from './billing-read.service'
import { RatedPeriod } from './entities/rated-period.entity'

function ratedPeriod(overrides: Partial<RatedPeriod> = {}): RatedPeriod {
  return {
    id: 'rated-1',
    usagePeriodArchiveId: 'archive-1',
    organizationId: 'org-1',
    boxId: 'box-1',
    pricingSegments: [
      {
        pricingVersion: 1,
        startAt: '2026-07-10T10:00:00.000Z',
        endAt: '2026-07-10T10:10:00.000Z',
        billedSeconds: '600',
        unitRates: {
          cpuRateCentsPerSec: '0.0014',
          memRateCentsPerSec: '0.00045',
          diskRateCentsPerSec: '0.000003',
          gpuRateCentsPerSec: '0',
        },
        usageTotals: {
          cpuSeconds: '1200',
          memGibSeconds: '2400',
          diskGibSeconds: '6000',
          gpuSeconds: '0',
        },
        preciseCents: '2.778',
      },
    ],
    usageTotals: {
      cpuSeconds: '1200',
      memGibSeconds: '2400',
      diskGibSeconds: '6000',
      gpuSeconds: '0',
    },
    billedSeconds: '600',
    preciseCents: '2.778',
    ratedCents: '3',
    ratedAt: new Date('2026-07-10T10:11:00.000Z'),
    ...overrides,
  }
}

describe('aggregateRatedPeriods', () => {
  it('prorates cost and physical usage to the requested time overlap', () => {
    const summary = aggregateRatedPeriods(
      [ratedPeriod()],
      new Date('2026-07-10T10:02:30.000Z'),
      new Date('2026-07-10T10:07:30.000Z'),
    )

    expect(summary).toEqual({
      costPreciseCents: '1.389',
      costCents: '1',
      cpuSeconds: '600',
      memGibSeconds: '1200',
      diskGibSeconds: '3000',
      gpuSeconds: '0',
      periodCount: 1,
    })
  })

  it('counts each rated period once when it has multiple overlapping pricing segments', () => {
    const first = ratedPeriod()
    const secondSegment = {
      ...first.pricingSegments[0],
      pricingVersion: 2,
      startAt: '2026-07-10T10:10:00.000Z',
      endAt: '2026-07-10T10:20:00.000Z',
    }
    first.pricingSegments.push(secondSegment)

    const summary = aggregateRatedPeriods(
      [first],
      new Date('2026-07-10T10:00:00.000Z'),
      new Date('2026-07-10T10:20:00.000Z'),
    )

    expect(summary.periodCount).toBe(1)
  })
})

describe('buildUsageBuckets', () => {
  it('builds real contiguous trend buckets from pricing segments', () => {
    const buckets = buildUsageBuckets(
      [ratedPeriod()],
      new Date('2026-07-10T10:00:00.000Z'),
      new Date('2026-07-10T10:10:00.000Z'),
      2,
    )

    expect(buckets).toEqual([
      expect.objectContaining({
        from: '2026-07-10T10:00:00.000Z',
        to: '2026-07-10T10:05:00.000Z',
        costPreciseCents: '1.389',
      }),
      expect.objectContaining({
        from: '2026-07-10T10:05:00.000Z',
        to: '2026-07-10T10:10:00.000Z',
        costPreciseCents: '1.389',
      }),
    ])
  })
})

describe('parseBillingRange', () => {
  it('rejects invalid and reversed ranges at the API boundary', () => {
    expect(() => parseBillingRange('not-a-date', undefined)).toThrow(BadRequestException)
    expect(() => parseBillingRange('2026-07-10T11:00:00.000Z', '2026-07-10T10:00:00.000Z')).toThrow(
      'from must be earlier than to',
    )
  })
})

describe('BillingReadService', () => {
  it('returns real wallet pools, month spend, range usage, and active pricing', async () => {
    const wallet = {
      freeBalanceCents: '8400',
      paidBalanceCents: '2500',
      billingStatus: 'trial',
      freeExpiresAt: new Date('2026-08-09T10:00:00.000Z'),
    }
    const periodQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([ratedPeriod()]),
    }
    const ratedPeriods = { createQueryBuilder: jest.fn().mockReturnValue(periodQuery) }
    const spendQuery = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ spentCents: '37' }),
    }
    const walletTransactions = { createQueryBuilder: jest.fn().mockReturnValue(spendQuery) }
    const pricingPlans = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            version: 1,
            cpuRateCentsPerSec: '0.0014',
            memRateCentsPerSec: '0.00045',
            diskRateCentsPerSec: '0.000003',
            gpuRateCentsPerSec: '0',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      }),
    }
    const service = new BillingReadService(
      ratedPeriods as never,
      walletTransactions as never,
      pricingPlans as never,
      { getOrCreateWallet: jest.fn().mockResolvedValue(wallet) } as never,
      {
        evaluate: jest.fn().mockResolvedValue({
          hasAccess: true,
          availableCents: '10875',
          unbilledUsageCents: '20',
          safetyBufferCents: '5',
        }),
      } as never,
    )

    const overview = await service.getOverview(
      'org-1',
      new Date('2026-07-10T10:00:00.000Z'),
      new Date('2026-07-10T10:10:00.000Z'),
    )

    expect(overview.wallet).toEqual({
      freeBalanceCents: '8400',
      paidBalanceCents: '2500',
      totalBalanceCents: '10900',
      billingStatus: 'trial',
      freeExpiresAt: '2026-08-09T10:00:00.000Z',
    })
    expect(overview.access).toEqual({
      hasAccess: true,
      availableCents: '10875',
      unbilledUsageCents: '20',
      safetyBufferCents: '5',
    })
    expect(overview.spentThisMonthCents).toBe('37')
    expect(overview.usage.costPreciseCents).toBe('2.778')
    expect(overview.usageBuckets).toHaveLength(12)
    expect(overview.pricing.cpuRateCentsPerHour).toBe('5.04')
    expect(periodQuery.andWhere).toHaveBeenCalledWith('rp."ratedAt" >= :from', {
      from: new Date('2026-07-10T10:00:00.000Z'),
    })
    expect(periodQuery.andWhere).toHaveBeenCalledWith(expect.stringContaining('jsonb_array_elements'), {
      from: new Date('2026-07-10T10:00:00.000Z'),
      to: new Date('2026-07-10T10:10:00.000Z'),
    })
    expect(spendQuery.innerJoin).toHaveBeenCalled()
    expect(spendQuery.andWhere).toHaveBeenCalledWith(expect.stringContaining('pricingSegments'), expect.any(Object))
  })

  it('aggregates a box total in PostgreSQL without loading its full history', async () => {
    const aggregateQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        costPreciseCents: '2.778',
        cpuSeconds: '1200',
        memGibSeconds: '2400',
        diskGibSeconds: '6000',
        gpuSeconds: '0',
        periodCount: '1',
      }),
    }
    const ratedPeriods = { createQueryBuilder: jest.fn().mockReturnValue(aggregateQuery) }
    const service = new BillingReadService(ratedPeriods as never, {} as never, {} as never, {} as never, {} as never)

    const summary = await service.getBoxUsage('org-1', 'box-1')

    expect(aggregateQuery.where).toHaveBeenCalledWith('rp."organizationId" = :organizationId', {
      organizationId: 'org-1',
    })
    expect(aggregateQuery.andWhere).toHaveBeenCalledWith('rp."boxId" = :boxId', { boxId: 'box-1' })
    expect(summary.costPreciseCents).toBe('2.778')
    expect(summary.costCents).toBe('3')
  })
})
