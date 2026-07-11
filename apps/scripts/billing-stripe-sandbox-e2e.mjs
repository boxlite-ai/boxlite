#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { chromium } from 'playwright-core'
import { assertLocalStripeDatabase, assertStripeE2EEvidence } from './billing-stripe-sandbox-config.mjs'

const { Client } = pg
const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'http://localhost:3000')
const loginEmail = process.env.BOXLITE_E2E_LOGIN_EMAIL || 'admin@boxlite.dev'
const loginPassword = process.env.BOXLITE_E2E_LOGIN_PASSWORD || 'password'
const timeoutMs = Number(process.env.BILLING_STRIPE_E2E_TIMEOUT_MS || 60_000)
const chromeExecutablePath =
  process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const database = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 25432),
  user: process.env.DB_USERNAME || 'boxlite',
  password: process.env.DB_PASSWORD || 'boxlite',
  database: process.env.DB_DATABASE || 'boxlite',
}
const hostStartedAt = new Date()
const runId = hostStartedAt.toISOString().replaceAll(/[:.]/g, '-')
const artifactsDir =
  process.env.BOXLITE_BILLING_E2E_ARTIFACTS || path.join(repoRoot, '.apps-local', 'logs', 'billing-stripe-e2e', runId)

assertLocalStripeDatabase(database)
await fs.mkdir(artifactsDir, { recursive: true })

const db = new Client(database)
await db.connect()
const runStartedAt = await loadDatabaseTime()
const browser = await chromium.launch({
  headless: process.env.HEADLESS !== 'false',
  executablePath: chromeExecutablePath,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const localHttpErrors = []
let organizationId = null

page.setDefaultTimeout(timeoutMs)
page.on('request', (request) => {
  const match = new URL(request.url()).pathname.match(/^\/api\/organization\/([^/]+)\/billing\//)
  if (match) organizationId = match[1]
})
page.on('response', (response) => {
  if (response.status() >= 400 && isLocalUrl(response.url()) && !isExpectedAdminAccessProbe(response)) {
    localHttpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  }
})

try {
  await signIn()
  await page.goto(`${dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
  await waitFor(() => organizationId, 'Billing organization request')

  const walletBefore = await loadWallet(organizationId)
  await resetLocalPaymentProvider(organizationId)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Set up payment method', exact: true }).waitFor()

  await page.getByRole('button', { name: 'Set up payment method', exact: true }).click()
  await page
    .getByText(
      'Stripe securely saves this card for future top-ups. Automatic charges occur only after you enable auto-reload.',
      { exact: true },
    )
    .waitFor()
  await page.getByRole('button', { name: 'Confirm setup', exact: true }).click()
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//)

  const stripeEmail = page.getByRole('textbox', { name: 'Email', exact: true })
  if ((await stripeEmail.count()) === 1) {
    await stripeEmail.fill(loginEmail)
  } else {
    await page.getByText(loginEmail, { exact: true }).waitFor()
  }
  await page.getByRole('textbox', { name: 'Card number', exact: true }).fill('4242424242424242')
  await page.getByRole('textbox', { name: 'Expiration', exact: true }).fill('1230')
  await page.getByRole('textbox', { name: 'CVC', exact: true }).fill('123')
  await page.getByRole('textbox', { name: 'Cardholder name', exact: true }).fill('BoxLite Test')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(`${dashboardUrl}/dashboard/billing?payment=success`)

  await waitFor(async () => {
    const wallet = await loadWallet(organizationId)
    return wallet.paymentProviderCustomerId?.startsWith('cus_') && wallet.paymentProviderMethodId?.startsWith('pm_')
  }, 'Stripe setup webhook')
  await page.screenshot({ path: path.join(artifactsDir, 'stripe-setup-complete.png'), fullPage: true })

  await page.getByRole('button', { name: 'Add funds', exact: true }).click()
  await page.getByRole('textbox', { name: 'Custom top-up amount', exact: true }).fill('5.00')
  await page.getByRole('button', { name: 'Top up', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm top-up', exact: true }).click()
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//)
  await page.getByRole('button', { name: 'Pay', exact: true }).click()
  await page.waitForURL(`${dashboardUrl}/dashboard/billing?payment=success`)

  const topUp = await waitFor(() => loadPaidTopUp(organizationId), 'paid Stripe top-up')
  const walletAfter = await loadWallet(organizationId)
  const ledgerTopUpIds = await loadLedgerTopUpIds(topUp.id)
  const providerEventTypes = await loadProviderEventTypes()
  const evidence = {
    paidBalanceBeforeCents: walletBefore.paidBalanceCents,
    paidBalanceAfterCents: walletAfter.paidBalanceCents,
    wallet: walletAfter,
    topUp,
    ledgerTopUpIds,
    providerEventTypes,
  }
  assertStripeE2EEvidence(evidence)
  assertNoLocalHttpErrors()

  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  await page.getByRole('heading', { name: '▸ Receipts', exact: true }).waitFor()
  await page.screenshot({ path: path.join(artifactsDir, 'stripe-top-up-complete.png'), fullPage: true })
  console.log(
    JSON.stringify(
      {
        ok: true,
        organizationId,
        paidBalanceBeforeCents: evidence.paidBalanceBeforeCents,
        paidBalanceAfterCents: evidence.paidBalanceAfterCents,
        topUpId: topUp.id,
        providerReferenceType: topUp.providerReference.slice(0, 3),
        ledgerCredits: ledgerTopUpIds.length,
        providerEventTypes,
        artifactsDir,
      },
      null,
      2,
    ),
  )
} catch (error) {
  await page.screenshot({ path: path.join(artifactsDir, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
  await db.end()
}

async function signIn() {
  await page.goto(`${dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await settleAuthState()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      await page
        .locator('#login')
        .isVisible()
        .catch(() => false)
    ) {
      await page.locator('#login').fill(loginEmail)
      await page.locator('#password').fill(loginPassword)
      await page.locator('#submit-login').click()
      await settleAuthState()
      continue
    }

    const grantButton = page.getByRole('button', { name: 'Grant Access', exact: true })
    if (await grantButton.isVisible().catch(() => false)) {
      await grantButton.click()
      await settleAuthState()
      continue
    }
    break
  }

  if (!page.url().startsWith(new URL(dashboardUrl).origin)) {
    throw new Error(`Stripe E2E could not complete local sign-in; current URL is ${page.url()}`)
  }
}

async function settleAuthState() {
  await Promise.race([
    page.getByRole('heading', { name: 'Billing', exact: true }).waitFor(),
    page.locator('#login').waitFor(),
    page.getByRole('button', { name: 'Grant Access', exact: true }).waitFor(),
  ])
}

async function loadWallet(targetOrganizationId) {
  const result = await db.query(
    `SELECT "paidBalanceCents", "paymentProviderCustomerId", "paymentProviderMethodId", "paymentMethodLast4"
       FROM wallet WHERE "organizationId" = $1`,
    [targetOrganizationId],
  )
  if (result.rowCount !== 1) throw new Error(`Expected one wallet for organization ${targetOrganizationId}`)
  return result.rows[0]
}

async function loadDatabaseTime() {
  const result = await db.query('SELECT clock_timestamp() AS now')
  return result.rows[0].now
}

async function resetLocalPaymentProvider(targetOrganizationId) {
  await db.query(
    `UPDATE wallet SET
       "paymentProviderCustomerId" = NULL,
       "paymentProviderMethodId" = NULL,
       "paymentMethodBrand" = NULL,
       "paymentMethodLast4" = NULL,
       "autoReloadEnabled" = false,
       "autoReloadThresholdCents" = NULL,
       "autoReloadTargetCents" = NULL,
       "autoReloadNextAttemptAt" = NULL
     WHERE "organizationId" = $1`,
    [targetOrganizationId],
  )
}

async function loadPaidTopUp(targetOrganizationId) {
  const result = await db.query(
    `SELECT id, status, "amountCents", "providerReference", "receiptUrl"
       FROM top_up_record
      WHERE "organizationId" = $1 AND source = 'manual' AND "createdAt" >= $2
      ORDER BY "createdAt" DESC LIMIT 1`,
    [targetOrganizationId, runStartedAt],
  )
  const topUp = result.rows[0]
  return topUp?.status === 'paid' ? topUp : null
}

async function loadLedgerTopUpIds(topUpId) {
  const result = await db.query(
    `SELECT metadata->>'topUpId' AS "topUpId"
       FROM wallet_transaction
      WHERE kind = 'top_up' AND metadata->>'topUpId' = $1`,
    [topUpId],
  )
  return result.rows.map((row) => row.topUpId)
}

async function loadProviderEventTypes() {
  const result = await db.query(
    `SELECT "eventType" FROM payment_provider_event WHERE "createdAt" >= $1 ORDER BY "createdAt"`,
    [runStartedAt],
  )
  return result.rows.map((row) => row.eventType)
}

async function waitFor(check, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function assertNoLocalHttpErrors() {
  if (localHttpErrors.length > 0) throw new Error(`Local HTTP failures:\n${localHttpErrors.join('\n')}`)
}

function isExpectedAdminAccessProbe(response) {
  return response.status() === 403 && new URL(response.url()).pathname === '/api/admin/overview'
}

function isLocalUrl(value) {
  const hostname = new URL(value).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}
