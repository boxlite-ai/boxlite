/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { QueryFailedError, Repository } from 'typeorm'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { UserResourceMultiplier } from '../entities/user-resource-multiplier.entity'
import { ratePeriodByPlans, UserMultiplierSnapshot } from './rate-math'

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
  constructor(
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly usageArchives: Repository<BoxUsagePeriodArchive>,
    @InjectRepository(RatedPeriod)
    private readonly ratedPeriods: Repository<RatedPeriod>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlans: Repository<PricingPlan>,
    @Optional()
    @InjectRepository(UserResourceMultiplier)
    private readonly userResourceMultipliers?: Repository<UserResourceMultiplier>,
  ) {}

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
    const [plans, multipliers] = await Promise.all([
      this.findPricingPlans(period),
      this.findUserMultipliers(period),
    ])
    const computation = ratePeriodByPlans(period, plans, multipliers)
    const row = this.ratedPeriods.create({
      usagePeriodArchiveId: period.id,
      organizationId: period.organizationId,
      billingUserId: period.billingUserId,
      boxId: period.boxId,
      usageStartAt: period.startAt,
      usageEndAt: period.endAt,
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

  private async findUserMultipliers(period: BoxUsagePeriodArchive): Promise<UserMultiplierSnapshot[]> {
    if (!period.billingUserId || !this.userResourceMultipliers) return []
    const rows = await this.userResourceMultipliers
      .createQueryBuilder('m')
      .where('m."organizationId" = :organizationId', { organizationId: period.organizationId })
      .andWhere('m."userId" = :userId', { userId: period.billingUserId })
      .andWhere('m."effectiveFrom" < :endAt', { endAt: period.endAt })
      .andWhere('(m."effectiveTo" IS NULL OR m."effectiveTo" > :startAt)', { startAt: period.startAt })
      .orderBy('m.effectiveFrom', 'ASC')
      .getMany()
    return rows.map((row) => ({
      cpu: row.cpuMultiplier,
      mem: row.memMultiplier,
      disk: row.diskMultiplier,
      gpu: row.gpuMultiplier,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    }))
  }
}
