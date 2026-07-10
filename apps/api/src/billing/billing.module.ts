/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationModule } from '../organization/organization.module'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { BillingController } from './billing.controller'
import { BillingReadService } from './billing-read.service'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { RatingService } from './rating/rating.service'
import { SettlementService } from './settlement.service'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    OrganizationModule,
    TypeOrmModule.forFeature([
      BoxUsagePeriodArchive,
      PricingPlan,
      RatedPeriod,
      Wallet,
      WalletTransaction,
      Organization,
    ]),
  ],
  controllers: [BillingController],
  providers: [RatingService, WalletService, SettlementService, BillingReadService],
  exports: [RatingService, WalletService, SettlementService, BillingReadService],
})
export class BillingModule {}
