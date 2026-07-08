#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import Redis from 'ioredis'
import { chromium } from 'playwright-core'

const { Pool } = pg

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const apiUrl = stripTrailingSlash(process.env.BOXLITE_E2E_API_URL || 'http://localhost:3001/api')
const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'http://localhost:3000')
const loginEmail = process.env.BOXLITE_E2E_LOGIN_EMAIL || 'admin@boxlite.dev'
const loginPassword = process.env.BOXLITE_E2E_LOGIN_PASSWORD || 'password'
const timeoutMs = Number(process.env.METERING_E2E_TIMEOUT_MS || 20_000)
const keepRows = process.env.METERING_E2E_KEEP_ROWS === '1'
const chromeExecutablePath =
  process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const artifactsDir = process.env.METERING_E2E_ARTIFACTS || path.join(repoRoot, '.apps-local', 'logs')
const apiKeyValue =
  process.env.METERING_E2E_API_KEY ||
  `blk_test_meteringe2e${Date.now().toString(36)}${crypto.randomBytes(12).toString('hex')}`
const apiKeyName = process.env.METERING_E2E_API_KEY_NAME || 'metering-local-e2e'
const runId = crypto.randomBytes(4).toString('hex')
const activeBoxId = `mtr${runId}`
const archivedBoxId = `arc${runId}`
const activePeriodId = crypto.randomUUID()
const archivedPeriodId = crypto.randomUUID()
const sourcePeriodId = crypto.randomUUID()

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 25432),
  user: process.env.DB_USERNAME || 'boxlite',
  password: process.env.DB_PASSWORD || 'boxlite',
  database: process.env.DB_DATABASE || 'boxlite',
  max: 4,
})

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 26379),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

let organizationId
let userId

try {
  await fs.mkdir(artifactsDir, { recursive: true })
  ;({ organizationId, userId } = await ensureApiKey())
  const window = await seedMeteringRows()
  await verifyApi(window)
  await verifyDashboard()

  console.log(
    JSON.stringify(
      {
        ok: true,
        apiUrl,
        dashboardUrl,
        organizationId,
        activeBoxId,
        archivedBoxId,
        keepRows,
        screenshot: path.join(artifactsDir, 'metering-local-e2e.png'),
      },
      null,
      2,
    ),
  )
} finally {
  await cleanupApiKey().catch((error) => {
    console.warn(`api key cleanup warning: ${error.message}`)
  })
  if (!keepRows) {
    await cleanupMeteringRows().catch((error) => {
      console.warn(`metering cleanup warning: ${error.message}`)
    })
  }
  await redis.quit().catch(() => {})
  await pool.end().catch(() => {})
}

async function ensureApiKey() {
  const { rows } = await pool.query(
    `
      select u.id as "userId", ou."organizationId" as "organizationId"
      from "user" u
      join organization_user ou on ou."userId" = u.id
      where u.email = $1 and ou.role = 'owner'
      limit 1
    `,
    [loginEmail],
  )
  if (rows.length === 0) {
    throw new Error(`No owner organization found for ${loginEmail}`)
  }

  const row = rows[0]
  const keyHash = hashApiKey(apiKeyValue)
  await pool.query('delete from api_key where "organizationId" = $1 and "userId" = $2 and name = $3', [
    row.organizationId,
    row.userId,
    apiKeyName,
  ])
  await pool.query(
    `
      insert into api_key (
        "organizationId",
        "userId",
        name,
        "keyHash",
        "keyPrefix",
        "keySuffix",
        permissions,
        "createdAt"
      )
      values ($1, $2, $3, $4, $5, $6, ARRAY[]::api_key_permissions_enum[], now())
    `,
    [row.organizationId, row.userId, apiKeyName, keyHash, displayPrefix(apiKeyValue), apiKeyValue.slice(-3)],
  )

  await redis.connect().catch(() => {})
  await redis.del(`api-key:validation:${keyHash}`).catch(() => {})
  await redis.del(`api-key:user:${row.userId}`).catch(() => {})

  return row
}

async function seedMeteringRows() {
  const to = new Date()
  to.setMilliseconds(0)
  const activeStart = new Date(to.getTime() - 60 * 60 * 1000)
  const archivedStart = new Date(to.getTime() - 2 * 60 * 60 * 1000)

  await cleanupMeteringRows()
  await pool.query(
    `
      insert into usage_period (
        id,
        "boxId",
        "organizationId",
        region,
        "startAt",
        "endAt",
        kind,
        cpu,
        gpu,
        mem,
        disk,
        "actualCpuSeconds",
        "actualRssAvgBytes",
        "actualRssPeakBytes",
        "sampleCount"
      )
      values ($1, $2, $3, $4, $5, null, 'running', 2, 1, 4, 10, null, null, null, null)
    `,
    [activePeriodId, activeBoxId, organizationId, 'local', activeStart],
  )
  await pool.query(
    `
      insert into usage_period_archive (
        id,
        "sourcePeriodId",
        "boxId",
        "organizationId",
        region,
        "startAt",
        "endAt",
        kind,
        cpu,
        gpu,
        mem,
        disk,
        "actualCpuSeconds",
        "actualRssAvgBytes",
        "actualRssPeakBytes",
        "sampleCount"
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'stopped', 0, 0, 0, 20, null, null, null, null)
    `,
    [archivedPeriodId, sourcePeriodId, archivedBoxId, organizationId, 'local', archivedStart, activeStart],
  )

  return { from: archivedStart.toISOString(), to: to.toISOString() }
}

async function verifyApi(window) {
  const activeData = await fetchMetering(window, activeBoxId)
  const archivedData = await fetchMetering(window, archivedBoxId)

  if (!activeData.activePeriods?.some((period) => period.boxId === activeBoxId && period.kind === 'running')) {
    throw new Error(`active seeded period missing from API response: ${JSON.stringify(activeData).slice(0, 400)}`)
  }
  if (
    !archivedData.archivedPeriods?.some((period) => period.boxId === archivedBoxId && period.kind === 'stopped')
  ) {
    throw new Error(`archived seeded period missing from API response: ${JSON.stringify(archivedData).slice(0, 400)}`)
  }
  assertNear(activeData.totals.cpuSeconds, 7200, 'active cpuSeconds')
  assertNear(activeData.totals.memGibSeconds, 14400, 'active memGibSeconds')
  assertNear(activeData.totals.diskGibSeconds, 36000, 'active diskGibSeconds')
  assertNear(activeData.totals.gpuSeconds, 3600, 'active gpuSeconds')
  assertNear(archivedData.totals.cpuSeconds, 0, 'archived cpuSeconds')
  assertNear(archivedData.totals.memGibSeconds, 0, 'archived memGibSeconds')
  assertNear(archivedData.totals.diskGibSeconds, 72000, 'archived diskGibSeconds')
  assertNear(archivedData.totals.gpuSeconds, 0, 'archived gpuSeconds')
}

async function fetchMetering(window, boxId) {
  const params = new URLSearchParams({ from: window.from, to: window.to, limit: '50', boxId })
  const response = await fetchWithTimeout(`${apiUrl}/organization/${organizationId}/metering?${params}`, {
    headers: {
      Authorization: `Bearer ${apiKeyValue}`,
      Accept: 'application/json',
    },
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`metering API failed for ${boxId}: HTTP ${response.status}: ${body.slice(0, 240)}`)
  }

  return JSON.parse(body)
}

async function verifyDashboard() {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    executablePath: chromeExecutablePath,
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(timeoutMs)
    await signIn(page)
    await page.goto(`${dashboardUrl}/dashboard/metering`, { waitUntil: 'domcontentloaded' })
    await assertBodyText(page, [
      'Metering',
      'OPEN LEDGER PERIODS',
      'CLOSED USAGE PERIODS',
      'Open stopped rows keep metering disk only.',
      activeBoxId,
      archivedBoxId,
      'RUNNING',
      'STOPPED',
    ])
    await page.screenshot({ path: path.join(artifactsDir, 'metering-local-e2e.png'), fullPage: true })
  } finally {
    await browser.close()
  }
}

async function signIn(page) {
  await page.goto(`${dashboardUrl}/dashboard/metering`, { waitUntil: 'domcontentloaded' })
  await settleAuthState(page)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await isVisible(page.locator('#login'))) {
      await page.locator('#login').fill(loginEmail)
      await page.locator('#password').fill(loginPassword)
      await page.locator('#submit-login').click()
      await settleAuthState(page, { allowDashboardOrigin: true })
      continue
    }

    const grantButton = page.getByRole('button', { name: 'Grant Access' })
    if (await isVisible(grantButton)) {
      await grantButton.click()
      await settleAuthState(page, { allowDashboardOrigin: true })
      continue
    }

    break
  }

  if (await isVisible(page.locator('#login'))) {
    throw new Error('Dex login is still visible after sign-in attempts')
  }
  if (await isVisible(page.getByRole('button', { name: 'Grant Access' }))) {
    throw new Error('Dex approval is still visible after sign-in attempts')
  }
}

async function settleAuthState(page, { allowDashboardOrigin = false } = {}) {
  const dashboardOrigin = new URL(dashboardUrl).origin
  let dashboardSeenAt = 0
  let lastBodyText = ''

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const currentUrl = page.url()
    const bodyText = await page.locator('body').innerText().catch(() => '')
    lastBodyText = bodyText
    if (/Log in to Your Account|Grant Access|Metering|Boxes|Billing/.test(bodyText)) {
      return
    }
    if (allowDashboardOrigin && currentUrl.startsWith(dashboardOrigin)) {
      dashboardSeenAt ||= Date.now()
      if (Date.now() - dashboardSeenAt > 3_000) {
        return
      }
    } else {
      dashboardSeenAt = 0
    }
    await delay(250)
  }
  throw new Error(
    `Timed out waiting for dashboard or Dex state at ${page.url()}; body=${lastBodyText.slice(0, 240)}`,
  )
}

async function assertBodyText(page, expectedTexts) {
  let missing = expectedTexts
  let lastBodyText = ''
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const bodyText = await page.locator('body').innerText()
    lastBodyText = bodyText
    missing = expectedTexts.filter((text) => !bodyText.includes(text))
    if (missing.length === 0) {
      return
    }
    await delay(250)
  }
  throw new Error(`Missing expected text: ${missing.join(', ')}; body=${lastBodyText.slice(0, 240)}`)
}

async function cleanupApiKey() {
  if (!organizationId || !userId) {
    return
  }
  const keyHash = hashApiKey(apiKeyValue)
  await pool.query('delete from api_key where "organizationId" = $1 and "userId" = $2 and name = $3', [
    organizationId,
    userId,
    apiKeyName,
  ])
  await redis.del(`api-key:validation:${keyHash}`).catch(() => {})
}

async function cleanupMeteringRows() {
  await pool.query(`delete from usage_period where "boxId" like 'mtr%'`)
  await pool.query(`delete from usage_period_archive where "boxId" like 'arc%'`)
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function isVisible(locator) {
  try {
    return await locator.isVisible()
  } catch {
    return false
  }
}

function hashApiKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function displayPrefix(value) {
  const first = value.indexOf('_')
  const second = first === -1 ? -1 : value.indexOf('_', first + 1)
  return second === -1 ? value.slice(0, 3) : value.slice(0, second + 1)
}

function assertNear(actual, expected, label) {
  if (Math.abs(Number(actual) - expected) > 0.001) {
    throw new Error(`${label} expected ${expected}, got ${actual}`)
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
