/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { TypedConfigService } from '../config/typed-config.service'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationModule } from '../organization/organization.module'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../usage/entities/box-usage-period.entity'
import { BillingAccessService } from './access/billing-access.service'
import { BillingController } from './billing.controller'
import { BillingOpsService } from './billing-ops.service'
import { BillingReadService } from './billing-read.service'
import { OrganizationSubscription } from './entities/organization-subscription.entity'
import { PaymentProviderEvent } from './entities/payment-provider-event.entity'
import { PricingPlan } from './entities/pricing-plan.entity'
import { RatedPeriod } from './entities/rated-period.entity'
import { SubscriptionEntitlement } from './entities/subscription-entitlement.entity'
import { SubscriptionPeriod } from './entities/subscription-period.entity'
import { SubscriptionPlan } from './entities/subscription-plan.entity'
import { TopUpRecord } from './entities/top-up-record.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { UserResourceMultiplier } from './entities/user-resource-multiplier.entity'
import { BillingPaymentController, PaymentWebhookController } from './payment/payment.controller'
import { PAYMENT_PROVIDER } from './payment/payment-provider'
import { createPaymentProvider } from './payment/payment-provider.factory'
import { PaymentService } from './payment/payment.service'
import { RatingService } from './rating/rating.service'
import { SettlementService } from './settlement.service'
import { SubscriptionController } from './subscription/subscription.controller'
import { SubscriptionService } from './subscription/subscription.service'
import { SubscriptionSettlementService } from './subscription/subscription-settlement.service'
import { UserResourceMultiplierService } from './subscription/user-resource-multiplier.service'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    OrganizationModule,
    TypeOrmModule.forFeature([
      Box,
      BoxUsagePeriod,
      BoxUsagePeriodArchive,
      OrganizationSubscription,
      PaymentProviderEvent,
      PricingPlan,
      RatedPeriod,
      SubscriptionEntitlement,
      SubscriptionPeriod,
      SubscriptionPlan,
      TopUpRecord,
      UserResourceMultiplier,
      Wallet,
      WalletTransaction,
      Organization,
    ]),
  ],
  controllers: [BillingController, BillingPaymentController, PaymentWebhookController, SubscriptionController],
  providers: [
    RatingService,
    WalletService,
    SubscriptionService,
    SubscriptionSettlementService,
    UserResourceMultiplierService,
    SettlementService,
    BillingReadService,
    BillingOpsService,
    PaymentService,
    BillingAccessService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [TypedConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [
    RatingService,
    WalletService,
    SubscriptionService,
    UserResourceMultiplierService,
    SettlementService,
    BillingReadService,
    BillingOpsService,
    PaymentService,
    BillingAccessService,
  ],
})
export class BillingModule {}
