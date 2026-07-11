/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TypedConfigService } from '../config/typed-config.service'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationModule } from '../organization/organization.module'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { BillingController } from './billing.controller'
import { BillingOpsService } from './billing-ops.service'
import { BillingReadService } from './billing-read.service'
import { PaymentProviderEvent } from './entities/payment-provider-event.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { TopUpRecord } from './entities/top-up-record.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { BillingPaymentController, PaymentWebhookController } from './payment/payment.controller'
import { PAYMENT_PROVIDER } from './payment/payment-provider'
import { createPaymentProvider } from './payment/payment-provider.factory'
import { PaymentService } from './payment/payment.service'
import { RatingService } from './rating/rating.service'
import { SettlementService } from './settlement.service'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    OrganizationModule,
    TypeOrmModule.forFeature([
      BoxUsagePeriodArchive,
      PaymentProviderEvent,
      PricingPlan,
      RatedPeriod,
      TopUpRecord,
      Wallet,
      WalletTransaction,
      Organization,
    ]),
  ],
  controllers: [BillingController, BillingPaymentController, PaymentWebhookController],
  providers: [
    RatingService,
    WalletService,
    SettlementService,
    BillingReadService,
    BillingOpsService,
    PaymentService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [TypedConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [RatingService, WalletService, SettlementService, BillingReadService, BillingOpsService, PaymentService],
})
export class BillingModule {}
