export const STRIPE_BILLING_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
]

export function assertStripeSandboxSecrets(secretKey, webhookSecret) {
  if (!/^sk_test_[A-Za-z0-9]+$/.test(secretKey ?? '')) {
    throw new Error('Stripe Sandbox requires a test-mode API key (sk_test_*)')
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret ?? '')) {
    throw new Error('Stripe Sandbox requires a webhook signing secret (whsec_*)')
  }
}

export function stripeListenArguments(forwardUrl) {
  const url = new URL(forwardUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Stripe webhook forwarding URL must use HTTP or HTTPS')
  }
  return ['listen', '--skip-update', '--events', STRIPE_BILLING_EVENTS.join(','), '--forward-to', url.toString()]
}

export function redactStripeSecrets(value) {
  return String(value).replace(/\b(?:(?:sk|rk|pk)_(?:test|live)|whsec)_[A-Za-z0-9]+\b/g, '[REDACTED]')
}

export function assertLocalStripeDatabase({ host, port, database }) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Stripe Sandbox E2E may reset payment fields only on loopback PostgreSQL')
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !database) {
    throw new Error('Stripe Sandbox E2E requires a valid local PostgreSQL target')
  }
}

export function assertMatchingStripeAccounts(apiAccountId, cliAccountId) {
  if (!/^acct_[A-Za-z0-9_]+$/.test(apiAccountId ?? '') || !/^acct_[A-Za-z0-9_]+$/.test(cliAccountId ?? '')) {
    throw new Error('Stripe Sandbox requires valid Stripe account IDs')
  }
  if (apiAccountId !== cliAccountId) {
    throw new Error('STRIPE_SECRET_KEY and Stripe CLI must use the same Stripe test account')
  }
}

export function assertMatchingWebhookSecrets(apiWebhookSecret, cliWebhookSecret) {
  if (apiWebhookSecret !== cliWebhookSecret) {
    throw new Error('The API and Stripe CLI listener must use the same webhook signing secret')
  }
}

export function assertStripeE2EEvidence(evidence) {
  if (!evidence.wallet.paymentProviderCustomerId?.startsWith('cus_')) {
    throw new Error('Stripe E2E did not persist a Stripe customer')
  }
  if (!evidence.wallet.paymentProviderMethodId?.startsWith('pm_') || evidence.wallet.paymentMethodLast4 !== '4242') {
    throw new Error('Stripe E2E did not persist the expected test card')
  }
  if (
    evidence.topUp.status !== 'paid' ||
    evidence.topUp.amountCents !== '500' ||
    !evidence.topUp.providerReference?.startsWith('cs_') ||
    !evidence.topUp.receiptUrl?.startsWith('https://')
  ) {
    throw new Error('Stripe E2E did not complete the expected $5 top-up')
  }
  if (evidence.ledgerTopUpIds.length !== 1 || evidence.ledgerTopUpIds[0] !== evidence.topUp.id) {
    throw new Error('Stripe E2E requires exactly one ledger credit for the top-up')
  }
  if (
    !evidence.providerEventTypes.includes('setup_succeeded') ||
    !evidence.providerEventTypes.includes('top_up_paid')
  ) {
    throw new Error('Stripe E2E did not consume both setup and top-up webhooks')
  }
  if (BigInt(evidence.paidBalanceAfterCents) - BigInt(evidence.paidBalanceBeforeCents) !== 500n) {
    throw new Error('Stripe E2E paid balance must increase by 500 cents')
  }
}
