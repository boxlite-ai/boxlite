#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'http://localhost:3000')
const loginEmail = process.env.BOXLITE_E2E_LOGIN_EMAIL || 'admin@boxlite.dev'
const loginPassword = process.env.BOXLITE_E2E_LOGIN_PASSWORD || 'password'
const timeoutMs = Number(process.env.BILLING_E2E_TIMEOUT_MS || 20_000)
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
  const requestError = `REQUEST FAILED ${request.method()} ${request.resourceType()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown error'}`
  if (isLocalUrl(request.url())) {
    browserErrors.push(`network: ${requestError}`)
  } else {
    externalHttpWarnings.push(requestError)
  }
})

await context.tracing.start({ screenshots: true, snapshots: true, sources: true })

try {
  await signIn()
  await verifyUsageTab()
  await verifyBillingTab()
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
