/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Decimal from 'decimal.js'
import { Repository } from 'typeorm'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { WalletService } from './wallet.service'
import { BillingAccessService } from './access/billing-access.service'

export interface BillingUsageSummary {
  costPreciseCents: string
  costCents: string
  cpuSeconds: string
  memGibSeconds: string
  diskGibSeconds: string
  gpuSeconds: string
  periodCount: number
}

export interface BillingUsageBucket extends BillingUsageSummary {
  from: string
  to: string
}

export interface BillingRange {
  from: Date
  to: Date
}

export interface BillingPricing {
  version: number
  effectiveFrom: string
  cpuRateCentsPerHour: string
  memRateCentsPerHour: string
  diskRateCentsPerHour: string
  gpuRateCentsPerHour: string
}

export interface BillingOverview {
  wallet: {
    freeBalanceCents: string
    paidBalanceCents: string
    totalBalanceCents: string
    billingStatus: string
    freeExpiresAt: string | null
  }
  access: {
    hasAccess: boolean
    availableCents: string
    unbilledUsageCents: string
    safetyBufferCents: string
  }
  spentThisMonthCents: string
  usage: BillingUsageSummary
  usageBuckets: BillingUsageBucket[]
  pricing: BillingPricing
}

export function buildUsageBuckets(
  periods: RatedPeriod[],
  from: Date,
  to: Date,
  bucketCount: number,
): BillingUsageBucket[] {
  const count = Math.max(1, Math.min(48, Math.trunc(bucketCount)))
  const durationMilliseconds = to.getTime() - from.getTime()
  if (durationMilliseconds <= 0) {
    throw new Error('usage bucket range must have a positive duration')
  }

  return Array.from({ length: count }, (_, index) => {
    const bucketFrom = new Date(from.getTime() + Math.round((durationMilliseconds * index) / count))
    const bucketTo = new Date(from.getTime() + Math.round((durationMilliseconds * (index + 1)) / count))
    return {
      from: bucketFrom.toISOString(),
      to: bucketTo.toISOString(),
      ...aggregateRatedPeriods(periods, bucketFrom, bucketTo),
    }
  })
}

export function aggregateRatedPeriods(periods: RatedPeriod[], from: Date, to: Date): BillingUsageSummary {
  let costPreciseCents = new Decimal(0)
  let cpuSeconds = new Decimal(0)
  let memGibSeconds = new Decimal(0)
  let diskGibSeconds = new Decimal(0)
  let gpuSeconds = new Decimal(0)
  const overlappingPeriodIds = new Set<string>()

  for (const period of periods) {
    for (const segment of period.pricingSegments) {
      const segmentStart = new Date(segment.startAt).getTime()
      const segmentEnd = new Date(segment.endAt).getTime()
      const overlapStart = Math.max(from.getTime(), segmentStart)
      const overlapEnd = Math.min(to.getTime(), segmentEnd)
      if (overlapEnd <= overlapStart || segmentEnd <= segmentStart) {
        continue
      }

      const overlapRatio = new Decimal(overlapEnd - overlapStart).div(segmentEnd - segmentStart)
      costPreciseCents = costPreciseCents.plus(new Decimal(segment.preciseCents).mul(overlapRatio))
      cpuSeconds = cpuSeconds.plus(new Decimal(segment.usageTotals.cpuSeconds).mul(overlapRatio))
      memGibSeconds = memGibSeconds.plus(new Decimal(segment.usageTotals.memGibSeconds).mul(overlapRatio))
      diskGibSeconds = diskGibSeconds.plus(new Decimal(segment.usageTotals.diskGibSeconds).mul(overlapRatio))
      gpuSeconds = gpuSeconds.plus(new Decimal(segment.usageTotals.gpuSeconds).mul(overlapRatio))
      overlappingPeriodIds.add(period.id)
    }
  }

  return {
    costPreciseCents: costPreciseCents.toString(),
    costCents: costPreciseCents.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString(),
    cpuSeconds: cpuSeconds.toString(),
    memGibSeconds: memGibSeconds.toString(),
    diskGibSeconds: diskGibSeconds.toString(),
    gpuSeconds: gpuSeconds.toString(),
    periodCount: overlappingPeriodIds.size,
  }
}

export function parseBillingRange(from?: string, to?: string): BillingRange {
  const parsedTo = to ? new Date(to) : new Date()
  const parsedFrom = from ? new Date(from) : new Date(parsedTo.getTime() - 30 * 24 * 60 * 60 * 1000)
  if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
    throw new BadRequestException('from and to must be valid ISO dates')
  }
  if (parsedFrom.getTime() >= parsedTo.getTime()) {
    throw new BadRequestException('from must be earlier than to')
  }
  return { from: parsedFrom, to: parsedTo }
}

@Injectable()
export class BillingReadService {
  constructor(
    @InjectRepository(RatedPeriod)
    private readonly ratedPeriods: Repository<RatedPeriod>,
    @InjectRepository(WalletTransaction)
    private readonly walletTransactions: Repository<WalletTransaction>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlans: Repository<PricingPlan>,
    private readonly walletService: WalletService,
    private readonly billingAccessService: BillingAccessService,
  ) {}

  async getOverview(organizationId: string, from: Date, to: Date): Promise<BillingOverview> {
    const [wallet, periods, spentThisMonthCents, pricing, access] = await Promise.all([
      this.walletService.getOrCreateWallet(organizationId),
      this.findOverlappingPeriods(organizationId, from, to),
      this.getSpentThisMonthCents(organizationId, to),
      this.getPricing(to),
      this.billingAccessService.evaluate(organizationId),
    ])

    return {
      wallet: {
        freeBalanceCents: wallet.freeBalanceCents,
        paidBalanceCents: wallet.paidBalanceCents,
        totalBalanceCents: (BigInt(wallet.freeBalanceCents) + BigInt(wallet.paidBalanceCents)).toString(),
        billingStatus: wallet.billingStatus,
        freeExpiresAt: wallet.freeExpiresAt?.toISOString() ?? null,
      },
      access: {
        hasAccess: access.hasAccess,
        availableCents: access.availableCents,
        unbilledUsageCents: access.unbilledUsageCents,
        safetyBufferCents: access.safetyBufferCents,
      },
      spentThisMonthCents,
      usage: aggregateRatedPeriods(periods, from, to),
      usageBuckets: buildUsageBuckets(periods, from, to, 12),
      pricing,
    }
  }

  async getBoxUsage(organizationId: string, boxId: string): Promise<BillingUsageSummary> {
    const result = await this.ratedPeriods
      .createQueryBuilder('rp')
      .select('COALESCE(SUM(rp."preciseCents"), 0)::text', 'costPreciseCents')
      .addSelect(`COALESCE(SUM((rp."usageTotals"->>'cpuSeconds')::numeric), 0)::text`, 'cpuSeconds')
      .addSelect(`COALESCE(SUM((rp."usageTotals"->>'memGibSeconds')::numeric), 0)::text`, 'memGibSeconds')
      .addSelect(`COALESCE(SUM((rp."usageTotals"->>'diskGibSeconds')::numeric), 0)::text`, 'diskGibSeconds')
      .addSelect(`COALESCE(SUM((rp."usageTotals"->>'gpuSeconds')::numeric), 0)::text`, 'gpuSeconds')
      .addSelect('COUNT(*)::int', 'periodCount')
      .where('rp."organizationId" = :organizationId', { organizationId })
      .andWhere('rp."boxId" = :boxId', { boxId })
      .getRawOne<{
        costPreciseCents: string
        cpuSeconds: string
        memGibSeconds: string
        diskGibSeconds: string
        gpuSeconds: string
        periodCount: string | number
      }>()
    const costPreciseCents = result?.costPreciseCents ?? '0'
    return {
      costPreciseCents,
      costCents: new Decimal(costPreciseCents).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString(),
      cpuSeconds: result?.cpuSeconds ?? '0',
      memGibSeconds: result?.memGibSeconds ?? '0',
      diskGibSeconds: result?.diskGibSeconds ?? '0',
      gpuSeconds: result?.gpuSeconds ?? '0',
      periodCount: Number(result?.periodCount ?? 0),
    }
  }

  async getPricing(at = new Date()): Promise<BillingPricing> {
    const pricing = await this.getActivePricing(at)
    return {
      version: pricing.version,
      effectiveFrom: pricing.effectiveFrom.toISOString(),
      cpuRateCentsPerHour: new Decimal(pricing.cpuRateCentsPerSec).mul(3600).toString(),
      memRateCentsPerHour: new Decimal(pricing.memRateCentsPerSec).mul(3600).toString(),
      diskRateCentsPerHour: new Decimal(pricing.diskRateCentsPerSec).mul(3600).toString(),
      gpuRateCentsPerHour: new Decimal(pricing.gpuRateCentsPerSec).mul(3600).toString(),
    }
  }

  private async getSpentThisMonthCents(organizationId: string, referenceTime: Date): Promise<string> {
    const monthStart = new Date(Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth(), 1))
    const monthEnd = toExclusiveMonth(referenceTime)
    const result = await this.walletTransactions
      .createQueryBuilder('wt')
      .select('COALESCE(SUM(-wt."amountCents"), 0)', 'spentCents')
      .innerJoin(RatedPeriod, 'rp', 'rp.id = wt."ratedPeriodId"')
      .where('wt."organizationId" = :organizationId', { organizationId })
      .andWhere('wt.kind = :kind', { kind: 'usage_debit' })
      // Attribute a debit to when its daily usage period began, not when a delayed
      // settlement happened to write the wallet transaction.
      .andWhere(
        `(SELECT MIN((segment->>'startAt')::timestamptz)
          FROM jsonb_array_elements(rp."pricingSegments") AS segment) >= :monthStart
         AND (SELECT MIN((segment->>'startAt')::timestamptz)
          FROM jsonb_array_elements(rp."pricingSegments") AS segment) < :monthEnd`,
        { monthStart, monthEnd },
      )
      .getRawOne<{ spentCents: string }>()
    return result?.spentCents ?? '0'
  }

  private findOverlappingPeriods(organizationId: string, from: Date, to: Date): Promise<RatedPeriod[]> {
    return this.ratedPeriods
      .createQueryBuilder('rp')
      .where('rp."organizationId" = :organizationId', { organizationId })
      .andWhere('rp."ratedAt" >= :from', { from })
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM jsonb_array_elements(rp."pricingSegments") AS segment
          WHERE (segment->>'startAt')::timestamptz < :to
            AND (segment->>'endAt')::timestamptz > :from
        )`,
        { from, to },
      )
      .getMany()
  }

  private async getActivePricing(at: Date): Promise<PricingPlan> {
    const plans = await this.pricingPlans
      .createQueryBuilder('p')
      .where('p."effectiveFrom" <= :at', { at })
      .andWhere('(p."effectiveTo" IS NULL OR p."effectiveTo" > :at)', { at })
      .orderBy('p."effectiveFrom"', 'DESC')
      .getMany()
    if (plans.length !== 1) {
      throw new ServiceUnavailableException(`expected one active pricing plan, found ${plans.length}`)
    }
    return plans[0]
  }
}

function toExclusiveMonth(referenceTime: Date): Date {
  return new Date(Date.UTC(referenceTime.getUTCFullYear(), referenceTime.getUTCMonth() + 1, 1))
}
