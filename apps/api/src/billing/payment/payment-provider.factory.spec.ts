/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FakePaymentProvider } from './fake-payment-provider'
import { selectPaymentProviderClass } from './payment-provider.factory'
import { StripePaymentProvider } from './stripe-payment-provider'

describe('selectPaymentProviderClass', () => {
  it('uses the fake provider outside production so infra-local keeps working', () => {
    expect(selectPaymentProviderClass({ NODE_ENV: 'development' })).toBe(FakePaymentProvider)
    expect(selectPaymentProviderClass({ NODE_ENV: 'test' })).toBe(FakePaymentProvider)
  })

  it('fails closed in production when Stripe webhook verification is not configured', () => {
    expect(() => selectPaymentProviderClass({ NODE_ENV: 'production' })).toThrow(/STRIPE_WEBHOOK_SECRET/)
  })

  it('uses the Stripe provider in production when webhook verification is configured', () => {
    expect(
      selectPaymentProviderClass({
        NODE_ENV: 'production',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      }),
    ).toBe(StripePaymentProvider)
  })
})
