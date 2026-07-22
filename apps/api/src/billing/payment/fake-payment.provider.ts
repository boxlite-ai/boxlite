/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import {
  PaymentProvider,
  PaymentReconcileInput,
  PaymentReconcileResult,
  PaymentSetupInput,
  PaymentSetupResult,
  SubscriptionChangeInput,
  SubscriptionChangeResult,
  SubscriptionCheckoutInput,
  SubscriptionCheckoutResult,
  ProviderWebhookEvent,
  TopUpPaymentInput,
  TopUpPaymentResult,
} from './payment-provider'

export class FakePaymentProvider implements PaymentProvider {
  readonly mode = 'fake' as const

  async createSetup(input: PaymentSetupInput): Promise<PaymentSetupResult> {
    return {
      status: 'ready',
      checkoutUrl: null,
      providerReference: `fake-setup-${input.walletId}`,
      providerCustomerId: input.providerCustomerId ?? `fake-customer-${input.walletId}`,
      paymentMethod: { id: `fake-card-${input.walletId}`, brand: 'visa', last4: '4242' },
    }
  }

  async createManualTopUp(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    return this.paidResult(input)
  }

  async chargeSavedMethod(input: TopUpPaymentInput): Promise<TopUpPaymentResult> {
    return this.paidResult(input)
  }

  async reconcile(input: PaymentReconcileInput): Promise<PaymentReconcileResult> {
    void input
    return { status: 'pending' }
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<SubscriptionCheckoutResult> {
    return {
      checkoutUrl: `https://fake.boxlite.test/subscription/${input.organizationId}/${input.planCode}`,
      providerReference: `fake-subscription-checkout-${input.organizationId}`,
      snapshot: this.subscriptionChange(
        {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          providerSubscriptionId: `fake-subscription-${input.organizationId}`,
          providerScheduleId: null,
          providerPriceId: input.providerPriceId,
          planCode: input.planCode,
        },
        null,
      ).snapshot,
    }
  }

  async upgradeSubscription(input: SubscriptionChangeInput): Promise<SubscriptionChangeResult> {
    return this.subscriptionChange(input, null)
  }

  async scheduleSubscriptionDowngrade(input: SubscriptionChangeInput): Promise<SubscriptionChangeResult> {
    return this.subscriptionChange(input, `fake-schedule-${input.providerSubscriptionId}`)
  }

  async parseWebhook(payload: Buffer, signature: string): Promise<ProviderWebhookEvent | null> {
    void payload
    void signature
    throw new BadRequestException('fake payment provider does not accept webhooks')
  }

  private subscriptionChange(
    input: SubscriptionChangeInput,
    providerScheduleId: string | null,
  ): SubscriptionChangeResult {
    const currentPeriodStart = new Date()
    const currentPeriodEnd = new Date(currentPeriodStart)
    currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + 1)
    return {
      providerScheduleId,
      snapshot: {
        organizationId: input.organizationId,
        providerSubscriptionId: input.providerSubscriptionId,
        providerCustomerId: `fake-customer-${input.organizationId}`,
        providerPriceId: input.providerPriceId,
        providerScheduleId,
        status: 'active',
        currentPeriodStart: currentPeriodStart.toISOString(),
        currentPeriodEnd: currentPeriodEnd.toISOString(),
      },
    }
  }

  private paidResult(input: TopUpPaymentInput): TopUpPaymentResult {
    return {
      status: 'paid',
      checkoutUrl: null,
      providerReference: `fake-payment-${input.topUpId}`,
      receiptUrl: null,
    }
  }
}
