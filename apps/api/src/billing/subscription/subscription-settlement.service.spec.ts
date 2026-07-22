/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import Decimal from 'decimal.js'
import { OrganizationSubscription } from '../entities/organization-subscription.entity'
import { SubscriptionEntitlement } from '../entities/subscription-entitlement.entity'
import { SubscriptionPeriod } from '../entities/subscription-period.entity'
import type { RatedPeriod } from '../entities/rated-period.entity'
import { SubscriptionPeriodPendingError, SubscriptionSettlementService } from './subscription-settlement.service'

class QueryBuilder<T> {
  constructor(private readonly rows: T[]) {}
  setLock() { return this }
  where() { return this }
  andWhere() { return this }
  orderBy() { return this }
  async getMany() { return this.rows }
}

class Repository<T extends object> {
  constructor(readonly rows: T[]) {}
  async findOne() { return this.rows[0] ?? null }
  createQueryBuilder() { return new QueryBuilder(this.rows) }
  async save(rows: T | T[]) { return rows }
}

function manager(
  periods: SubscriptionPeriod[],
  entitlements: SubscriptionEntitlement[],
  subscription?: OrganizationSubscription,
) {
  const repositories = new Map<unknown, Repository<object>>([
    [OrganizationSubscription, new Repository(subscription ? [subscription] : [])],
    [SubscriptionPeriod, new Repository(periods)],
    [SubscriptionEntitlement, new Repository(entitlements)],
  ])
  return { getRepository: (entity: unknown) => repositories.get(entity)! }
}

it('defers settlement while an active provider period is waiting for invoice.paid', async () => {
  const start = new Date('2026-07-01T00:00:00.000Z')
  const end = new Date('2026-07-01T00:01:00.000Z')
  const subscription = {
    status: 'active',
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
  } as OrganizationSubscription
  const rated = {
    id: 'rated-1',
    organizationId: 'organization-1',
    usageStartAt: start,
    usageEndAt: end,
    preciseCents: '1',
    pricingSegments: [],
  } as RatedPeriod

  await expect(
    new SubscriptionSettlementService().settle(manager([], [], subscription) as never, rated),
  ).rejects.toBeInstanceOf(SubscriptionPeriodPendingError)
})

it('conserves every resource cost when one pricing segment crosses multiple entitlement boundaries', async () => {
  const start = new Date('2026-07-01T00:00:00.000Z')
  const firstBoundary = new Date('2026-07-01T00:00:01.000Z')
  const secondBoundary = new Date('2026-07-01T00:00:02.000Z')
  const end = new Date('2026-07-01T00:00:03.000Z')
  const period = {
    id: 'period-1',
    organizationId: 'organization-1',
    periodStart: start,
    periodEnd: end,
    quotaGrantedPreciseCents: '0',
    quotaConsumedPreciseCents: '0',
  } as SubscriptionPeriod
  const entitlement = (effectiveFrom: Date, effectiveTo: Date | null) => ({
    subscriptionPeriodId: period.id,
    organizationId: period.organizationId,
    planCode: 'starter',
    effectiveFrom,
    effectiveTo,
    overageCpuMultiplier: '1',
    overageMemMultiplier: '1',
    overageDiskMultiplier: '1',
    overageGpuMultiplier: '1',
  }) as SubscriptionEntitlement
  const rated = {
    organizationId: period.organizationId,
    usageStartAt: start,
    usageEndAt: end,
    preciseCents: '1',
    pricingSegments: [{
      pricingVersion: 1,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      billedSeconds: '3',
      unitRates: { cpuRateCentsPerSec: '0', memRateCentsPerSec: '0', diskRateCentsPerSec: '0', gpuRateCentsPerSec: '0' },
      usageTotals: { cpuSeconds: '0', memGibSeconds: '0', diskGibSeconds: '0', gpuSeconds: '0' },
      resourceCosts: { cpuCents: '0.1', memCents: '0.2', diskCents: '0.3', gpuCents: '0.4' },
      preciseCents: '1',
    }],
  } as RatedPeriod

  const result = await new SubscriptionSettlementService().settle(
    manager(
      [period],
      [entitlement(start, firstBoundary), entitlement(firstBoundary, secondBoundary), entitlement(secondBoundary, null)],
    ) as never,
    rated,
  )

  expect(result.slices).toHaveLength(3)
  expect(result.slices.reduce((sum, slice) => sum.plus(slice.ratedPreciseCents), new Decimal(0)).toString()).toBe('1')
  expect(result.preciseChargeCents).toBe('1')
})
