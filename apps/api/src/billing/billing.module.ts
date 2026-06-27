/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OrganizationModule } from '../organization/organization.module'
import { UsagePeriod } from '../usage/entities/usage-period.entity'
import { BillingController } from './billing.controller'
import { BillingWebhookController } from './billing-webhook.controller'
import { CreditGrant } from './entities/credit-grant.entity'
import { CustomerRateOverride } from './entities/customer-rate-override.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { ProcessedStripeEvent } from './entities/processed-stripe-event.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { TopUpRecord } from './entities/top-up-record.entity'
import { Wallet } from './entities/wallet.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { FakePaymentProvider } from './payment/fake-payment-provider'
import { PAYMENT_PROVIDER } from './payment/payment-provider.interface'
import { TopUpService } from './payment/top-up.service'
import { WebhookService } from './payment/webhook.service'
import { PricingService } from './rating/pricing.service'
import { RatingService } from './rating/rating.service'
import { WalletService } from './wallet/wallet.service'

/**
 * Phase 2 billing: rates closed usage periods (RatingService) and runs the
 * dual-pool wallet (WalletService) + payment seam (Fake provider tonight,
 * Stripe later). OrganizationModule satisfies the controller guard deps (same
 * reason UsageModule imports it). UsagePeriod is read-only here — the rating
 * sweep consumes it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PricingPlan,
      CustomerRateOverride,
      RatedPeriod,
      Wallet,
      WalletTransaction,
      CreditGrant,
      ProcessedStripeEvent,
      TopUpRecord,
      UsagePeriod,
    ]),
    OrganizationModule,
  ],
  controllers: [BillingController, BillingWebhookController],
  providers: [
    RatingService,
    PricingService,
    WalletService,
    WebhookService,
    TopUpService,
    { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
  ],
  exports: [RatingService, WalletService],
})
export class BillingModule {}
