import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertLocalStripeDatabase,
  assertMatchingStripeAccounts,
  assertMatchingWebhookSecrets,
  assertStripeReconcileEvidence,
  assertStripeRefundEvidence,
  assertStripeE2EEvidence,
  assertStripeSandboxSecrets,
  redactStripeSecrets,
  stripeListenArguments,
} from './billing-stripe-sandbox-config.mjs'

test('accepts only Stripe test-mode API keys and webhook secrets', () => {
  assert.doesNotThrow(() => assertStripeSandboxSecrets('sk_test_example', 'whsec_example'))
  assert.throws(() => assertStripeSandboxSecrets('sk_live_example', 'whsec_example'), /test-mode API key/)
  assert.throws(() => assertStripeSandboxSecrets('sk_test_example', 'live_secret'), /webhook signing secret/)
})

test('listens only for payment events consumed by the API', () => {
  assert.deepEqual(stripeListenArguments('http://localhost:3001/api/billing/webhooks/payment'), [
    'listen',
    '--skip-update',
    '--events',
    'checkout.session.completed,checkout.session.expired,checkout.session.async_payment_failed,payment_intent.succeeded,payment_intent.payment_failed,refund.created,refund.updated,refund.failed,charge.dispute.created,charge.dispute.funds_withdrawn,charge.dispute.funds_reinstated',
    '--forward-to',
    'http://localhost:3001/api/billing/webhooks/payment',
  ])
})

test('redacts Stripe credentials from subprocess output', () => {
  assert.equal(
    redactStripeSecrets('key=sk_test_abc webhook=whsec_def live=sk_live_ghi'),
    'key=[REDACTED] webhook=[REDACTED] live=[REDACTED]',
  )
})

test('allows destructive setup only against the loopback local database', () => {
  assert.doesNotThrow(() => assertLocalStripeDatabase({ host: '127.0.0.1', port: 25432, database: 'boxlite' }))
  assert.doesNotThrow(() => assertLocalStripeDatabase({ host: 'localhost', port: 25432, database: 'boxlite' }))
  assert.throws(
    () => assertLocalStripeDatabase({ host: 'db.example.com', port: 5432, database: 'boxlite' }),
    /loopback PostgreSQL/,
  )
})

test('requires a real Stripe setup, one $5 credit, and one matching ledger row', () => {
  const evidence = {
    paidBalanceBeforeCents: '5502',
    paidBalanceAfterCents: '6002',
    wallet: {
      paymentProviderCustomerId: 'cus_test',
      paymentProviderMethodId: 'pm_test',
      paymentMethodLast4: '4242',
    },
    topUp: {
      id: 'top-up-1',
      status: 'paid',
      amountCents: '500',
      providerReference: 'cs_test_1',
      receiptUrl: 'https://pay.stripe.com/receipts/test',
    },
    ledgerTopUpIds: ['top-up-1'],
    providerEventTypes: ['setup_succeeded', 'top_up_paid'],
  }

  assert.doesNotThrow(() => assertStripeE2EEvidence(evidence))
  assert.throws(() => assertStripeE2EEvidence({ ...evidence, ledgerTopUpIds: ['top-up-1', 'top-up-1'] }), /one ledger/)
  assert.throws(() => assertStripeE2EEvidence({ ...evidence, paidBalanceAfterCents: '6502' }), /increase by 500/)
})

test('requires the API key and Stripe CLI to use the same account', () => {
  assert.doesNotThrow(() => assertMatchingStripeAccounts('acct_api', 'acct_api'))
  assert.throws(() => assertMatchingStripeAccounts('acct_api', 'acct_cli'), /same Stripe test account/)
  assert.throws(() => assertMatchingStripeAccounts('', 'acct_cli'), /valid Stripe account/)
})

test('requires the API and listener to use the same webhook secret', () => {
  assert.doesNotThrow(() => assertMatchingWebhookSecrets('whsec_same', 'whsec_same'))
  assert.throws(() => assertMatchingWebhookSecrets('whsec_api', 'whsec_cli'), /same webhook signing secret/)
})

test('requires a lost webhook to be recovered from the Stripe source of truth', () => {
  assert.doesNotThrow(() =>
    assertStripeReconcileEvidence({
      topUp: { id: 'top-up-1', providerReference: 'cs_recovered' },
      providerEvents: [
        {
          providerEventId: 'reconcile:cs_recovered:paid',
          eventType: 'top_up_paid',
          providerReference: 'cs_recovered',
        },
      ],
    }),
  )
  assert.throws(
    () =>
      assertStripeReconcileEvidence({
        topUp: { id: 'top-up-1', providerReference: 'cs_webhook' },
        providerEvents: [{ providerEventId: 'evt_webhook', eventType: 'top_up_paid', providerReference: 'cs_webhook' }],
      }),
    /reconciliation event/,
  )
})

test('requires one immutable debit for a Stripe refund', () => {
  assert.doesNotThrow(() =>
    assertStripeRefundEvidence({
      paidBalanceBeforeCents: '8502',
      paidBalanceAfterCents: '8002',
      amountCents: '-500',
      refundedCents: '500',
      matchingLedgerRows: 1,
    }),
  )
  assert.throws(
    () =>
      assertStripeRefundEvidence({
        paidBalanceBeforeCents: '8502',
        paidBalanceAfterCents: '7502',
        amountCents: '-500',
        refundedCents: '500',
        matchingLedgerRows: 2,
      }),
    /exactly one immutable/,
  )
})
