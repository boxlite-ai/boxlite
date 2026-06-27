/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { PricingPlan } from '../entities/pricing-plan.entity'

/**
 * Read access to the active pricing version. Kept tiny and separate from
 * RatingService so the wallet read-path can ask for the warn threshold without
 * depending on the rating sweep. "Active" is derived from the effective window
 * (`effectiveFrom <= at < effectiveTo`), never a stored flag.
 */
@Injectable()
export class PricingService {
  constructor(@InjectRepository(PricingPlan) private readonly plans: Repository<PricingPlan>) {}

  getActivePlan(at: Date = new Date()): Promise<PricingPlan | null> {
    return this.plans
      .createQueryBuilder('p')
      .where('p."effectiveFrom" <= :at', { at })
      .andWhere('(p."effectiveTo" IS NULL OR :at < p."effectiveTo")', { at })
      .orderBy('p.version', 'DESC')
      .getOne()
  }

  /** Low-balance warning line from the active plan (0 when no plan is configured yet). */
  async warnThresholdCents(at: Date = new Date()): Promise<number> {
    const plan = await this.getActivePlan(at)
    return plan ? Number(plan.warnThresholdCents) : 0
  }
}
