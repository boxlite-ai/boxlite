/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { billingHealthAlerts, BillingHealthSnapshot } from './billing-ops.service'

const healthy: BillingHealthSnapshot = {
  pendingPaymentCount: 0,
  pendingPaymentOldestSeconds: 0,
  failedWebhookCount: 0,
  failedWebhookOldestSeconds: 0,
  negativeWalletCount: 0,
  lowestWalletBalanceCents: '0',
  unratedPeriodCount: 0,
  unratedPeriodOldestSeconds: 0,
  unsettledPeriodCount: 0,
  unsettledPeriodOldestSeconds: 0,
  pendingPayment: null,
  failedWebhook: null,
  negativeWallet: null,
  unratedPeriod: null,
  unsettledPeriod: null,
}

describe('billingHealthAlerts', () => {
  it('stays quiet when payment and settlement pipelines are healthy', () => {
    expect(billingHealthAlerts(healthy)).toEqual([])
  })

  it('emits actionable codes for common payment and ledger failures', () => {
    expect(
      billingHealthAlerts({
        ...healthy,
        pendingPaymentCount: 3,
        pendingPaymentOldestSeconds: 901,
        failedWebhookCount: 2,
        failedWebhookOldestSeconds: 61,
        negativeWalletCount: 1,
        lowestWalletBalanceCents: '-250',
        unratedPeriodCount: 4,
        unratedPeriodOldestSeconds: 301,
        unsettledPeriodCount: 5,
        unsettledPeriodOldestSeconds: 302,
      }).map((alert) => alert.code),
    ).toEqual([
      'stale_pending_payment',
      'failed_payment_webhook',
      'negative_wallet_balance',
      'rating_lag',
      'settlement_lag',
    ])
  })
})
