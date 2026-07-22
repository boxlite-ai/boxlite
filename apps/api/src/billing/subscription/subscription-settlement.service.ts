/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import Decimal from 'decimal.js'
import { EntityManager } from 'typeorm'
import { OrganizationSubscription } from '../entities/organization-subscription.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { SubscriptionEntitlement } from '../entities/subscription-entitlement.entity'
import { SubscriptionPeriod } from '../entities/subscription-period.entity'
import type { PricingSegment, ResourceCosts } from '../rating/rate-math'
import { settleSegmentAgainstQuota } from './subscription-math'

export interface SubscriptionSettlementSlice {
  startAt: string
  endAt: string
  subscriptionPeriodId: string | null
  planCode: string | null
  ratedPreciseCents: string
  quotaCoveredPreciseCents: string
  overagePreciseCents: string
}

export interface SubscriptionSettlement {
  preciseChargeCents: string
  quotaCoveredPreciseCents: string
  slices: SubscriptionSettlementSlice[]
}

export class SubscriptionPeriodPendingError extends Error {}

@Injectable()
export class SubscriptionSettlementService {
  async settle(manager: EntityManager, ratedPeriod: RatedPeriod): Promise<SubscriptionSettlement> {
    const subscription = await manager.getRepository(OrganizationSubscription).findOne({
      where: { organizationId: ratedPeriod.organizationId },
      lock: { mode: 'pessimistic_write' },
    })
    const periods = await manager
      .getRepository(SubscriptionPeriod)
      .createQueryBuilder('period')
      .setLock('pessimistic_write')
      .where('period."organizationId" = :organizationId', { organizationId: ratedPeriod.organizationId })
      .andWhere('period."periodStart" < :endAt', { endAt: ratedPeriod.usageEndAt })
      .andWhere('period."periodEnd" > :startAt', { startAt: ratedPeriod.usageStartAt })
      .orderBy('period.periodStart', 'ASC')
      .getMany()

    if (periods.length === 0) {
      if (
        subscription?.status === 'active' &&
        subscription.currentPeriodStart &&
        subscription.currentPeriodEnd &&
        subscription.currentPeriodStart < ratedPeriod.usageEndAt &&
        subscription.currentPeriodEnd > ratedPeriod.usageStartAt
      ) {
        throw new SubscriptionPeriodPendingError(
          `subscription period is not paid yet for rated period ${ratedPeriod.id}`,
        )
      }
      return this.unsubscribedSettlement(ratedPeriod)
    }

    const entitlements = await manager
      .getRepository(SubscriptionEntitlement)
      .createQueryBuilder('entitlement')
      .where('entitlement."organizationId" = :organizationId', { organizationId: ratedPeriod.organizationId })
      .andWhere('entitlement."effectiveFrom" < :endAt', { endAt: ratedPeriod.usageEndAt })
      .andWhere('(entitlement."effectiveTo" IS NULL OR entitlement."effectiveTo" > :startAt)', {
        startAt: ratedPeriod.usageStartAt,
      })
      .orderBy('entitlement.effectiveFrom', 'ASC')
      .getMany()

    const slices: SubscriptionSettlementSlice[] = []
    let charge = new Decimal(0)
    let quotaCovered = new Decimal(0)
    for (const segment of ratedPeriod.pricingSegments) {
      const segmentStart = new Date(segment.startAt).getTime()
      const segmentEnd = new Date(segment.endAt).getTime()
      const boundaries = this.boundaries(segmentStart, segmentEnd, periods, entitlements)
      let allocatedCosts: ResourceCosts = { cpuCents: '0', memCents: '0', diskCents: '0', gpuCents: '0' }
      for (let index = 0; index < boundaries.length - 1; index++) {
        const start = boundaries[index]
        const end = boundaries[index + 1]
        const costs = this.sliceResourceCosts(segment, start, end, index === boundaries.length - 2, allocatedCosts)
        allocatedCosts = this.addResourceCosts(allocatedCosts, costs)
        const period = periods.find((candidate) => candidate.periodStart.getTime() <= start && start < candidate.periodEnd.getTime())
        const entitlement = period
          ? entitlements.find(
              (candidate) =>
                candidate.subscriptionPeriodId === period.id &&
                candidate.effectiveFrom.getTime() <= start &&
                (!candidate.effectiveTo || start < candidate.effectiveTo.getTime()),
            )
          : undefined
        const ratedPrecise = this.sumCosts(costs)
        if (!period || !entitlement) {
          charge = charge.plus(ratedPrecise)
          slices.push({
            startAt: new Date(start).toISOString(),
            endAt: new Date(end).toISOString(),
            subscriptionPeriodId: null,
            planCode: null,
            ratedPreciseCents: ratedPrecise.toString(),
            quotaCoveredPreciseCents: '0',
            overagePreciseCents: ratedPrecise.toString(),
          })
          continue
        }

        const available = Decimal.max(
          0,
          new Decimal(period.quotaGrantedPreciseCents).minus(period.quotaConsumedPreciseCents),
        )
        const result = settleSegmentAgainstQuota({
          resourceCosts: costs,
          quotaAvailablePreciseCents: available.toString(),
          overageMultipliers: {
            cpu: entitlement.overageCpuMultiplier,
            mem: entitlement.overageMemMultiplier,
            disk: entitlement.overageDiskMultiplier,
            gpu: entitlement.overageGpuMultiplier,
          },
        })
        period.quotaConsumedPreciseCents = new Decimal(period.quotaConsumedPreciseCents)
          .plus(result.quotaCoveredPreciseCents)
          .toString()
        charge = charge.plus(result.chargePreciseCents)
        quotaCovered = quotaCovered.plus(result.quotaCoveredPreciseCents)
        slices.push({
          startAt: new Date(start).toISOString(),
          endAt: new Date(end).toISOString(),
          subscriptionPeriodId: period.id,
          planCode: entitlement.planCode,
          ratedPreciseCents: ratedPrecise.toString(),
          quotaCoveredPreciseCents: result.quotaCoveredPreciseCents,
          overagePreciseCents: result.overagePreciseCents,
        })
      }
    }

    await manager.getRepository(SubscriptionPeriod).save(periods)
    return {
      preciseChargeCents: charge.toString(),
      quotaCoveredPreciseCents: quotaCovered.toString(),
      slices,
    }
  }

  private unsubscribedSettlement(ratedPeriod: RatedPeriod): SubscriptionSettlement {
    return {
      preciseChargeCents: ratedPeriod.preciseCents,
      quotaCoveredPreciseCents: '0',
      slices: ratedPeriod.pricingSegments.map((segment) => ({
        startAt: segment.startAt,
        endAt: segment.endAt,
        subscriptionPeriodId: null,
        planCode: null,
        ratedPreciseCents: segment.preciseCents,
        quotaCoveredPreciseCents: '0',
        overagePreciseCents: segment.preciseCents,
      })),
    }
  }

  private boundaries(
    start: number,
    end: number,
    periods: SubscriptionPeriod[],
    entitlements: SubscriptionEntitlement[],
  ): number[] {
    const boundaries = new Set([start, end])
    for (const period of periods) {
      if (start < period.periodStart.getTime() && period.periodStart.getTime() < end) boundaries.add(period.periodStart.getTime())
      if (start < period.periodEnd.getTime() && period.periodEnd.getTime() < end) boundaries.add(period.periodEnd.getTime())
    }
    for (const entitlement of entitlements) {
      if (start < entitlement.effectiveFrom.getTime() && entitlement.effectiveFrom.getTime() < end) {
        boundaries.add(entitlement.effectiveFrom.getTime())
      }
      if (entitlement.effectiveTo && start < entitlement.effectiveTo.getTime() && entitlement.effectiveTo.getTime() < end) {
        boundaries.add(entitlement.effectiveTo.getTime())
      }
    }
    return [...boundaries].sort((left, right) => left - right)
  }

  private sliceResourceCosts(
    segment: PricingSegment,
    start: number,
    end: number,
    isLastSlice: boolean,
    allocatedCosts: ResourceCosts,
  ): ResourceCosts {
    const costs = segment.resourceCosts ?? {
      cpuCents: segment.preciseCents,
      memCents: '0',
      diskCents: '0',
      gpuCents: '0',
    }
    const duration = new Decimal(new Date(segment.endAt).getTime() - new Date(segment.startAt).getTime())
    if (duration.isZero()) return costs
    const ratio = new Decimal(end - start).div(duration)
    if (!isLastSlice) {
      return {
        cpuCents: new Decimal(costs.cpuCents).mul(ratio).toString(),
        memCents: new Decimal(costs.memCents).mul(ratio).toString(),
        diskCents: new Decimal(costs.diskCents).mul(ratio).toString(),
        gpuCents: new Decimal(costs.gpuCents).mul(ratio).toString(),
      }
    }

    const remaining = {
      cpuCents: Decimal.max(0, new Decimal(costs.cpuCents).minus(allocatedCosts.cpuCents)).toString(),
      memCents: Decimal.max(0, new Decimal(costs.memCents).minus(allocatedCosts.memCents)).toString(),
      diskCents: Decimal.max(0, new Decimal(costs.diskCents).minus(allocatedCosts.diskCents)).toString(),
      gpuCents: Decimal.max(0, new Decimal(costs.gpuCents).minus(allocatedCosts.gpuCents)).toString(),
    }
    return {
      cpuCents: remaining.cpuCents,
      memCents: remaining.memCents,
      diskCents: remaining.diskCents,
      gpuCents: remaining.gpuCents,
    }
  }
  private addResourceCosts(left: ResourceCosts, right: ResourceCosts): ResourceCosts {
    return {
      cpuCents: new Decimal(left.cpuCents).plus(right.cpuCents).toString(),
      memCents: new Decimal(left.memCents).plus(right.memCents).toString(),
      diskCents: new Decimal(left.diskCents).plus(right.diskCents).toString(),
      gpuCents: new Decimal(left.gpuCents).plus(right.gpuCents).toString(),
    }
  }

  private sumCosts(costs: ResourceCosts): Decimal {
    return new Decimal(costs.cpuCents).plus(costs.memCents).plus(costs.diskCents).plus(costs.gpuCents)
  }
}
