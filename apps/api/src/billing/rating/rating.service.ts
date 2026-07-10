/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { QueryFailedError, Repository } from 'typeorm'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { ratePeriodByPlans } from './rate-math'

const PG_UNIQUE_VIOLATION = '23505'
const RATING_BATCH_SIZE = 100

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION
  )
}

@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name)

  constructor(
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly usageArchives: Repository<BoxUsagePeriodArchive>,
    @InjectRepository(RatedPeriod)
    private readonly ratedPeriods: Repository<RatedPeriod>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlans: Repository<PricingPlan>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'rate-usage-periods' })
  async scheduledSweep(): Promise<void> {
    const result = await this.rateClosedPeriods()
    if (result.rated || result.skipped) {
      this.logger.log(`rating sweep: rated ${result.rated}, skipped ${result.skipped}`)
    }
  }

  async rateClosedPeriods(limit = RATING_BATCH_SIZE): Promise<{ rated: number; skipped: number }> {
    const periods = await this.findUnratedArchivedPeriods(limit)
    let rated = 0
    let skipped = 0

    for (const period of periods) {
      if (await this.ratePeriod(period)) {
        rated++
      } else {
        skipped++
      }
    }

    return { rated, skipped }
  }

  async ratePeriod(period: BoxUsagePeriodArchive): Promise<RatedPeriod | null> {
    const plans = await this.findPricingPlans(period)
    const computation = ratePeriodByPlans(period, plans)
    const row = this.ratedPeriods.create({
      usagePeriodArchiveId: period.id,
      organizationId: period.organizationId,
      boxId: period.boxId,
      ...computation,
    })

    try {
      return (await this.ratedPeriods.save(row)) ?? null
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    }
  }

  private findUnratedArchivedPeriods(limit: number): Promise<BoxUsagePeriodArchive[]> {
    return this.usageArchives
      .createQueryBuilder('up')
      .leftJoin(RatedPeriod, 'rp', 'rp."usagePeriodArchiveId" = up.id')
      .where('rp.id IS NULL')
      .orderBy('up.startAt', 'ASC')
      .take(limit)
      .getMany()
  }

  private findPricingPlans(period: BoxUsagePeriodArchive): Promise<PricingPlan[]> {
    return this.pricingPlans
      .createQueryBuilder('p')
      .where('p."effectiveFrom" < :endAt', { endAt: period.endAt })
      .andWhere('(p."effectiveTo" IS NULL OR p."effectiveTo" > :startAt)', { startAt: period.startAt })
      .orderBy('p.effectiveFrom', 'ASC')
      .getMany()
  }
}
