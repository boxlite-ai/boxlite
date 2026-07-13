#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import pg from 'pg'

const { Client } = pg

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'http://localhost:3000')
const loginEmail = process.env.BOXLITE_E2E_LOGIN_EMAIL || 'admin@boxlite.dev'
const loginPassword = process.env.BOXLITE_E2E_LOGIN_PASSWORD || 'password'
const timeoutMs = Number(process.env.BILLING_E2E_TIMEOUT_MS || 20_000)
const runEnforcementLifecycle = process.env.BILLING_ENFORCEMENT_E2E === '1'
const chromeExecutablePath =
  process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
const artifactsDir =
  process.env.BOXLITE_BILLING_E2E_ARTIFACTS || path.join(repoRoot, '.apps-local', 'logs', 'billing-e2e', runId)

await fs.mkdir(artifactsDir, { recursive: true })

const browser = await chromium.launch({
  headless: process.env.HEADLESS !== 'false',
  executablePath: chromeExecutablePath,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const browserErrors = []
const expectedHttpErrors = []
const externalHttpWarnings = []
let tracingStopped = false
let authorizationHeader = ''
let selectedOwnerOrganizationId = ''

page.setDefaultTimeout(timeoutMs)
page.on('console', (message) => {
  if (message.type() === 'error' && !isBrowserNetworkConsoleMessage(message.text())) {
    browserErrors.push(`console: ${message.text()}`)
  }
})
page.on('pageerror', (error) => browserErrors.push(`page: ${error.message}`))
page.on('response', (response) => {
  if (response.status() < 400) return

  const httpError = describeHttpError(response)
  if (process.env.BILLING_E2E_DEBUG_HTTP === '1') console.error(`[billing-e2e] ${httpError}`)

  if (isExpectedAdminAccessProbe(response)) {
    expectedHttpErrors.push(httpError)
  } else if (isLocalUrl(response.url())) {
    browserErrors.push(`http: ${httpError}`)
  } else {
    externalHttpWarnings.push(httpError)
  }
})
page.on('requestfailed', (request) => {
  const failureText = request.failure()?.errorText ?? 'unknown error'
  if (failureText === 'net::ERR_ABORTED') return

  const requestError = `REQUEST FAILED ${request.method()} ${request.resourceType()} ${request.url()}: ${failureText}`
  if (isLocalUrl(request.url())) {
    browserErrors.push(`network: ${requestError}`)
  } else {
    externalHttpWarnings.push(requestError)
  }
})
page.on('request', (request) => {
  const authorization = request.headers().authorization
  if (authorization?.startsWith('Bearer ') && isLocalUrl(request.url())) authorizationHeader = authorization
})

await context.tracing.start({ screenshots: true, snapshots: true, sources: true })

try {
  await signIn()
  await selectOwnerOrganization()
  await verifyUsageTab()
  await verifyBillingTab()
  let enforcement = null
  if (runEnforcementLifecycle) enforcement = await verifyEnforcementLifecycle()
  assertNoBrowserErrors()
  await context.tracing.stop()
  tracingStopped = true
  console.log(
    JSON.stringify(
      {
        ok: true,
        dashboardUrl,
        artifactsDir,
        screenshots: ['usage.png', 'billing.png'],
        expectedHttpErrors,
        externalHttpWarnings,
        enforcement,
      },
      null,
      2,
    ),
  )
} catch (error) {
  await page.screenshot({ path: path.join(artifactsDir, 'failure.png'), fullPage: true }).catch(() => {})
  if (!tracingStopped) {
    await context.tracing.stop({ path: path.join(artifactsDir, 'trace.zip') }).catch(() => {})
    tracingStopped = true
  }
  throw error
} finally {
  if (!tracingStopped) await context.tracing.stop().catch(() => {})
  await browser.close()
}

async function signIn() {
  await page.goto(`${dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await settleAuthState()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await isVisible(page.locator('#login'))) {
      await page.locator('#login').fill(loginEmail)
      await page.locator('#password').fill(loginPassword)
      await page.locator('#submit-login').click()
      await settleAuthState({ allowDashboardOrigin: true })
      continue
    }

    const grantButton = page.getByRole('button', { name: 'Grant Access' })
    if (await isVisible(grantButton)) {
      await grantButton.click()
      await settleAuthState({ allowDashboardOrigin: true })
      continue
    }

    break
  }

  if (await isVisible(page.locator('#login'))) throw new Error('Dex login is still visible')
  if (await isVisible(page.getByRole('button', { name: 'Grant Access' }))) {
    throw new Error('Dex approval is still visible')
  }
}

async function verifyUsageTab() {
  await page.goto(`${dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  await assertBodyText([
    'Current balance',
    'Spent this month',
    'Payment method',
    'Limits',
    'Per-box maximums',
    'Usage over time',
    'Usage Cost',
    'vCPU Hours',
    'RAM Hours',
    'Disk Hours',
  ])
  await page.screenshot({ path: path.join(artifactsDir, 'usage.png'), fullPage: true })
}

async function verifyBillingTab() {
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  await assertBodyText(['Top-up', 'Auto-reload', 'One-time top-up', 'Receipts'])
  await page.getByPlaceholder('search receipts...').waitFor()
  await page.screenshot({ path: path.join(artifactsDir, 'billing.png'), fullPage: true })
}

async function selectOwnerOrganization() {
  await waitFor(() => Promise.resolve(Boolean(authorizationHeader)), timeoutMs, 'an authenticated dashboard request')
  const organizations = await apiJson('GET', '/organizations')
  const token = authorizationHeader.slice('Bearer '.length)
  const authenticatedUserId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub

  for (const organization of organizations) {
    const members = await apiJson('GET', `/organizations/${organization.id}/users`)
    if (members.some((member) => member.userId === authenticatedUserId && member.role === 'owner')) {
      selectedOwnerOrganizationId = organization.id
      await page.evaluate(
        (organizationId) => localStorage.setItem('SelectedOrganizationId', organizationId),
        organization.id,
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      return
    }
  }

  throw new Error('Authenticated local user does not own an organization')
}

async function verifyEnforcementLifecycle() {
  assertLocalOnly()
  const organizationId = selectedOwnerOrganizationId
  if (!organizationId) throw new Error('No organization is available for Billing enforcement E2E')

  const overview = await apiJson('GET', `/organization/${organizationId}/billing/overview`)
  if (!overview.access?.hasAccess) throw new Error('Billing enforcement E2E requires a funded local wallet')

  const existingBoxes = await apiJson('GET', `/v1/${organizationId}/boxes`, undefined, organizationId)
  for (const box of existingBoxes.boxes ?? []) {
    if (box.name?.startsWith('billing-enforcement-')) {
      await apiResponse('DELETE', `/v1/${organizationId}/boxes/${box.box_id}`, undefined, organizationId)
    }
  }

  const boxName = `billing-enforcement-${Date.now()}`
  let boxId = ''
  let walletSnapshot = null
  const database = new Client({
    host: process.env.BILLING_E2E_DB_HOST || '127.0.0.1',
    port: Number(process.env.BILLING_E2E_DB_PORT || 25432),
    user: process.env.BILLING_E2E_DB_USERNAME || 'boxlite',
    password: process.env.BILLING_E2E_DB_PASSWORD || 'boxlite',
    database: process.env.BILLING_E2E_DB_DATABASE || 'boxlite',
  })

  await database.connect()
  try {
    const created = await apiJson(
      'POST',
      `/v1/${organizationId}/boxes`,
      {
        name: boxName,
        cpus: 1,
        memory_mib: 1024,
        disk_size_gb: 10,
      },
      organizationId,
      201,
    )
    boxId = created.box_id
    if (!boxId) throw new Error('Create Box response did not include box_id')

    const walletResult = await database.query(
      `SELECT "freeBalanceCents", "paidBalanceCents", "settlementRemainderCents", "freeExpiresAt", "billingStatus"
       FROM wallet WHERE "organizationId" = $1`,
      [organizationId],
    )
    walletSnapshot = walletResult.rows[0]
    if (!walletSnapshot) throw new Error(`Wallet missing for organization ${organizationId}`)

    await database.query(
      `UPDATE wallet
       SET "freeBalanceCents" = 0, "paidBalanceCents" = 0, "settlementRemainderCents" = 0,
           "freeExpiresAt" = NULL, "billingStatus" = 'zero_balance'
       WHERE "organizationId" = $1`,
      [organizationId],
    )

    const blockedCreate = await apiResponse(
      'POST',
      `/v1/${organizationId}/boxes`,
      { name: `${boxName}-blocked`, cpus: 1, memory_mib: 1024, disk_size_gb: 10 },
      organizationId,
    )
    await assertBillingBlocked(blockedCreate, 'Create')

    await waitFor(
      async () => {
        const box = await apiJson('GET', `/v1/${organizationId}/boxes/${boxId}`, undefined, organizationId)
        return box.status === 'stopped'
      },
      90_000,
      'the minute sweep to stop the unfunded Box',
    )

    const blockedStart = await apiResponse(
      'POST',
      `/v1/${organizationId}/boxes/${boxId}/start`,
      undefined,
      organizationId,
    )
    await assertBillingBlocked(blockedStart, 'Start')

    const blockedProxy = await apiResponse(
      'POST',
      `/v1/${organizationId}/boxes/${boxId}/exec`,
      { command: 'true' },
      organizationId,
    )
    await assertBillingBlocked(blockedProxy, 'Proxy auto-start')

    return { organizationId, boxId, createStatus: 402, startStatus: 402, proxyStatus: 402, sweepStoppedBox: true }
  } finally {
    if (walletSnapshot) {
      await database.query(
        `UPDATE wallet
         SET "freeBalanceCents" = $2, "paidBalanceCents" = $3, "settlementRemainderCents" = $4,
             "freeExpiresAt" = $5, "billingStatus" = $6
         WHERE "organizationId" = $1`,
        [
          organizationId,
          walletSnapshot.freeBalanceCents,
          walletSnapshot.paidBalanceCents,
          walletSnapshot.settlementRemainderCents,
          walletSnapshot.freeExpiresAt,
          walletSnapshot.billingStatus,
        ],
      )
    }
    if (boxId) {
      await apiResponse('DELETE', `/v1/${organizationId}/boxes/${boxId}`, undefined, organizationId).catch(() => {})
    }
    await database.end()
  }
}

async function apiJson(method, path, data, organizationId, expectedStatus = 200) {
  const response = await apiResponse(method, path, data, organizationId)
  if (response.status() !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status()}: ${await response.text()}`)
  }
  return response.json()
}

async function apiResponse(method, path, data, organizationId) {
  if (!authorizationHeader) throw new Error('Dashboard did not expose an authenticated local API request')
  try {
    return await context.request.fetch(`${dashboardUrl}/api${path}`, {
      method,
      data,
      failOnStatusCode: false,
      timeout: Math.max(timeoutMs, 120_000),
      headers: {
        Authorization: authorizationHeader,
        ...(organizationId ? { 'X-BoxLite-Organization-ID': organizationId } : {}),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/Authorization: Bearer [^\n]+/g, 'Authorization: Bearer [REDACTED]'))
  }
}

async function assertBillingBlocked(response, operation) {
  const body = await response.json().catch(() => ({}))
  if (response.status() !== 402 || body.code !== 'BILLING_BALANCE_REQUIRED') {
    throw new Error(`${operation} was not blocked by Billing: HTTP ${response.status()} ${JSON.stringify(body)}`)
  }
}

async function waitFor(predicate, timeout, description) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(1_000)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function assertLocalOnly() {
  const hostname = new URL(dashboardUrl).hostname
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error(`Billing enforcement E2E refuses non-loopback dashboard URL: ${dashboardUrl}`)
  }
  const databaseHost = process.env.BILLING_E2E_DB_HOST || '127.0.0.1'
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseHost)) {
    throw new Error(`Billing enforcement E2E refuses non-loopback database host: ${databaseHost}`)
  }
}

async function settleAuthState({ allowDashboardOrigin = false } = {}) {
  const dashboardOrigin = new URL(dashboardUrl).origin
  let dashboardSeenAt = 0
  let lastBodyText = ''

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const currentUrl = page.url()
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    lastBodyText = bodyText
    if (/Log in to Your Account|Grant Access|Billing|Boxes/.test(bodyText)) return
    if (allowDashboardOrigin && currentUrl.startsWith(dashboardOrigin)) {
      dashboardSeenAt ||= Date.now()
      if (Date.now() - dashboardSeenAt > 3_000) return
    } else {
      dashboardSeenAt = 0
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for dashboard or Dex state at ${page.url()}; body=${lastBodyText.slice(0, 240)}`)
}

async function assertBodyText(expectedTexts) {
  let missing = expectedTexts
  let lastBodyText = ''
  for (let attempt = 0; attempt < 80; attempt += 1) {
    lastBodyText = await page.locator('body').innerText()
    const normalizedBodyText = lastBodyText.toLowerCase()
    missing = expectedTexts.filter((text) => !normalizedBodyText.includes(text.toLowerCase()))
    if (missing.length === 0) return
    await delay(250)
  }
  throw new Error(`Missing expected text: ${missing.join(', ')}; body=${lastBodyText.slice(0, 240)}`)
}

function assertNoBrowserErrors() {
  if (browserErrors.length > 0) {
    throw new Error(`Billing browser errors:\n${browserErrors.join('\n')}`)
  }
}

function describeHttpError(response) {
  return `HTTP ${response.status()} ${response.request().method()} ${response.request().resourceType()} ${response.url()}`
}

function isExpectedAdminAccessProbe(response) {
  const request = response.request()
  return (
    response.status() === 403 &&
    request.method() === 'GET' &&
    request.resourceType() === 'xhr' &&
    new URL(response.url()).pathname === '/api/admin/overview'
  )
}

function isBrowserNetworkConsoleMessage(message) {
  return message.startsWith('Failed to load resource:')
}

function isLocalUrl(value) {
  const hostname = new URL(value).hostname
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'
}

async function isVisible(locator) {
  try {
    return await locator.isVisible()
  } catch {
    return false
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
