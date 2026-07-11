/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import {
  PaymentProvider,
  PaymentSetupInput,
  PaymentSetupResult,
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

  async parseWebhook(): Promise<ProviderWebhookEvent | null> {
    throw new BadRequestException('fake payment provider does not accept webhooks')
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
