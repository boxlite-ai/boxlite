/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Organization } from '../organization/entities/organization.entity'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { RatingService } from './rating/rating.service'
import { SettlementService } from './settlement.service'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BoxUsagePeriodArchive,
      PricingPlan,
      RatedPeriod,
      Wallet,
      WalletTransaction,
      Organization,
    ]),
  ],
  providers: [RatingService, WalletService, SettlementService],
  exports: [RatingService, WalletService, SettlementService],
})
export class BillingModule {}
