/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TypedConfigService } from '../../config/typed-config.service'
import { FakePaymentProvider } from './fake-payment.provider'
import { PaymentProvider } from './payment-provider'
import { StripePaymentProvider } from './stripe-payment.provider'

export function createPaymentProvider(configService: TypedConfigService): PaymentProvider {
  const mode = configService.get('billing.paymentProvider')
  if (mode === 'fake') return new FakePaymentProvider()
  if (mode !== 'stripe') throw new Error(`unsupported billing payment provider: ${String(mode)}`)

  const secretKey = configService.get('billing.stripe.secretKey')
  const webhookSecret = configService.get('billing.stripe.webhookSecret')
  if (!secretKey || !webhookSecret) {
    throw new Error('Stripe payment provider requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET')
  }
  return new StripePaymentProvider(secretKey, webhookSecret)
}
