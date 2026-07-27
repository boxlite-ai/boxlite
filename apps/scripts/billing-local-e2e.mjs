#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { BillingE2ESession } from './billing-e2e-session.mjs'

const { Client } = pg

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsRoot, '..', '..')
const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'http://localhost:3000')
const timeoutMs = Number(process.env.BILLING_E2E_TIMEOUT_MS || 20_000)
const runEnforcementLifecycle = process.env.BILLING_ENFORCEMENT_E2E === '1'
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
const artifactsDir =
  process.env.BOXLITE_BILLING_E2E_ARTIFACTS || path.join(repoRoot, '.apps-local', 'logs', 'billing-e2e', runId)

const session = await BillingE2ESession.launch({ artifactsDir, timeoutMs })
const { page } = session
let selectedOwnerOrganizationId = ''

try {
  selectedOwnerOrganizationId = await session.signInAndSelectOwner()
  await verifyUsageTab()
  await verifyBillingTab()
  let enforcement = null
  if (runEnforcementLifecycle) enforcement = await verifyEnforcementLifecycle()
  session.assertNoBrowserErrors()
  const { expectedHttpErrors, externalHttpWarnings } = session.diagnostics()
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
  await session.screenshot('failure.png').catch(() => {})
  throw error
} finally {
  await session.close()
}

async function verifyUsageTab() {
  await page.goto(`${dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()
  await session.assertBodyText([
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
  await session.screenshot('usage.png')
}

async function verifyBillingTab() {
  await page.getByRole('tab', { name: 'Billing', exact: true }).click()
  await session.assertBodyText(['Top-up', 'Auto-reload', 'One-time top-up', 'Receipts'])
  await page.getByPlaceholder('search receipts...').waitFor()
  await session.screenshot('billing.png')
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
  return session.apiJson(method, path, { body: data, organizationId, expectedStatus })
}

async function apiResponse(method, path, data, organizationId) {
  return session.apiResponse(method, path, { body: data, organizationId })
}

async function assertBillingBlocked(response, operation) {
  const body = await response.json().catch(() => ({}))
  if (response.status() !== 402 || body.code !== 'BILLING_BALANCE_REQUIRED') {
    throw new Error(`${operation} was not blocked by Billing: HTTP ${response.status()} ${JSON.stringify(body)}`)
  }
}

async function waitFor(predicate, timeout, description) {
  return session.waitFor(predicate, timeout, description, 1_000)
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

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}
