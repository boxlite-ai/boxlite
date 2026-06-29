/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FakePaymentProvider } from './fake-payment-provider'
import { PaymentProvider } from './payment-provider.interface'
import { StripePaymentProvider } from './stripe-payment-provider'

type PaymentProviderClass = new () => PaymentProvider

interface PaymentProviderEnv {
  NODE_ENV?: string
  PAYMENT_PROVIDER?: string
  STRIPE_WEBHOOK_SECRET?: string
}

export function selectPaymentProviderClass(env: PaymentProviderEnv = process.env): PaymentProviderClass {
  const requested = env.PAYMENT_PROVIDER?.toLowerCase()
  if (requested && requested !== 'fake' && requested !== 'stripe') {
    throw new Error(`Unsupported PAYMENT_PROVIDER "${env.PAYMENT_PROVIDER}"`)
  }

  const mustUseStripe = env.NODE_ENV === 'production' || requested === 'stripe'
  if (!mustUseStripe) return FakePaymentProvider

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be set before enabling Stripe payments')
  }
  return StripePaymentProvider
}

export function createPaymentProvider(env: PaymentProviderEnv = process.env): PaymentProvider {
  const Provider = selectPaymentProviderClass(env)
  return new Provider()
}
