/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, QueryFailedError, Repository } from 'typeorm'
import { UsagePeriod } from '../../usage/entities/usage-period.entity'
import { CustomerRateOverride } from '../entities/customer-rate-override.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { WalletService } from '../wallet/wallet.service'
import { computeRatedCents, periodBillableTotals, resolveRateSnapshot } from './rate-math'

const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
}

/**
 * Rates closed Phase-1 usage periods into `rated_period` rows. Runs as a sweep
 * (not on a live event) because a period is only billable once it is *closed*
 * (`periodEnd` set on a state change / reconcile). Idempotent: one usage period
 * → at most one rated row, enforced by `UNIQUE(usagePeriodId)`; a duplicate save
 * is swallowed, so re-running the sweep (or a crash mid-sweep) never double-bills.
 * The rate snapshot is frozen onto the row, so a later price change can't move it.
 */
@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name)

  constructor(
    @InjectRepository(UsagePeriod) private readonly usagePeriods: Repository<UsagePeriod>,
    @InjectRepository(RatedPeriod) private readonly ratedPeriods: Repository<RatedPeriod>,
    @InjectRepository(PricingPlan) private readonly plans: Repository<PricingPlan>,
    @InjectRepository(CustomerRateOverride) private readonly overrides: Repository<CustomerRateOverride>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledSweep(): Promise<void> {
    const { rated, skipped } = await this.rateClosedPeriods()
    if (rated || skipped) this.logger.log(`rating sweep: rated ${rated}, skipped ${skipped}`)
  }

  /** Rate every closed-but-unrated usage period. Safe to re-run. */
  async rateClosedPeriods(): Promise<{ rated: number; skipped: number }> {
    const periods = await this.findUnratedClosedPeriods()
    let rated = 0
    let skipped = 0
    for (const period of periods) {
      const row = await this.ratePeriod(period)
      if (row) rated++
      else skipped++
    }
    return { rated, skipped }
  }

  /** Rate one period; returns null if it was already rated (idempotent) or has no plan. */
  async ratePeriod(period: UsagePeriod): Promise<RatedPeriod | null> {
    if (!period.periodEnd) return null

    const plan = await this.planForMoment(period.periodStart)
    if (!plan) {
      this.logger.warn(`no pricing plan effective at ${period.periodStart.toISOString()} for period ${period.id}`)
      return null
    }
    const override = await this.overrideForOrg(period.organizationId, period.periodStart)

    const snapshot = resolveRateSnapshot(plan, override ?? undefined)
    const { totals, billedSeconds } = periodBillableTotals({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      kind: period.kind,
      allocCpu: period.allocCpu,
      allocMemGib: period.allocMemGib,
      allocDiskGib: period.allocDiskGib,
    })
    const { preciseCents, ratedCents } = computeRatedCents(totals, snapshot)

    const row = this.ratedPeriods.create({
      usagePeriodId: period.id,
      organizationId: period.organizationId,
      boxId: period.boxId,
      pricingVersion: plan.version,
      unitRates: snapshot,
      billedSeconds: String(billedSeconds),
      preciseCents,
      ratedCents: String(ratedCents),
    })

    try {
      return await this.dataSource.transaction(async (manager) => {
        const saved = await manager.save(row)
        if (ratedCents > 0) {
          await this.wallet.debitWithin(manager, period.organizationId, ratedCents, {
            source: 'usage',
            ratedPeriodId: saved.id,
          })
        }
        return saved
      })
    } catch (err) {
      if (isUniqueViolation(err)) return null // already rated by a concurrent/earlier sweep
      throw err
    }
  }

  /** Closed usage periods with no rated_period yet (the rating work list). */
  private findUnratedClosedPeriods(): Promise<UsagePeriod[]> {
    return this.usagePeriods
      .createQueryBuilder('up')
      .leftJoin(RatedPeriod, 'rp', 'rp."usagePeriodId" = up.id')
      .where('up."periodEnd" IS NOT NULL')
      .andWhere('rp.id IS NULL')
      .orderBy('up."periodStart"', 'ASC')
      .getMany()
  }

  /** The pricing version in force at `at` (effectiveFrom <= at < effectiveTo). */
  private planForMoment(at: Date): Promise<PricingPlan | null> {
    return this.plans
      .createQueryBuilder('p')
      .where('p."effectiveFrom" <= :at', { at })
      .andWhere('(p."effectiveTo" IS NULL OR :at < p."effectiveTo")', { at })
      .orderBy('p.version', 'DESC')
      .getOne()
  }

  /** The active per-customer override at `at`, if any. */
  private overrideForOrg(organizationId: string, at: Date): Promise<CustomerRateOverride | null> {
    return this.overrides
      .createQueryBuilder('o')
      .where('o."organizationId" = :organizationId', { organizationId })
      .andWhere('o."effectiveFrom" <= :at', { at })
      .andWhere('(o."effectiveTo" IS NULL OR :at < o."effectiveTo")', { at })
      .orderBy('o."effectiveFrom"', 'DESC')
      .getOne()
  }
}
