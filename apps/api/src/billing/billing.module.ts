/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { RatingService } from './rating/rating.service'

@Module({
  imports: [TypeOrmModule.forFeature([BoxUsagePeriodArchive, PricingPlan, RatedPeriod])],
  providers: [RatingService],
  exports: [RatingService],
})
export class BillingModule {}
