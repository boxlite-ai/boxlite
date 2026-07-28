#!/usr/bin/env node

import fs from 'node:fs'

const dashboardUrl = stripTrailingSlash(process.env.BOXLITE_E2E_BASE_URL || 'https://dev.boxlite.ai')
const apiUrl = stripTrailingSlash(process.env.BOXLITE_E2E_API_URL || `${dashboardUrl}/api`)
const openapiUrl = process.env.BOXLITE_E2E_OPENAPI_URL || `${dashboardUrl}/api-json`
const openapiFile = process.env.BOXLITE_E2E_OPENAPI_FILE
const apiKey = process.env.BOXLITE_E2E_API_KEY || process.env.BOXLITE_API_KEY
const requireApiKey = process.env.BOXLITE_E2E_REQUIRE_API_KEY === 'true'
const skipDashboard = process.env.BOXLITE_E2E_SKIP_DASHBOARD === 'true'
const skipConfig = process.env.BOXLITE_E2E_SKIP_CONFIG === 'true'
const skipHttpProbes = process.env.BOXLITE_E2E_SKIP_HTTP_PROBES === 'true'

const forbiddenOpenApiTokens = [
  'autoArchiveInterval',
  '/archive',
  '/autoarchive',
  'archiveSandbox',
  'setAutoArchive',
  'SandboxDesiredState.ARCHIVED',
]

const forbiddenDashboardTokens = [
  'Auto-archive',
  'autoArchiveInterval',
  'Archive selected',
  'Archive sandbox',
  'archiveSandbox',
  'setAutoArchiveInterval',
]

let failures = 0
let skipped = 0

const openapi = await loadOpenApi()

await check('OpenAPI does not expose archive/auto-archive active contract', () => {
  const text = JSON.stringify(openapi)
  for (const token of forbiddenOpenApiTokens) {
    assert(!text.includes(token), `OpenAPI still contains ${token}`)
  }

  const paths = normalizedPaths(openapi)
  for (const path of paths) {
    assert(!path.includes('/archive'), `OpenAPI still exposes archive path ${path}`)
    assert(!path.includes('/autoarchive'), `OpenAPI still exposes autoarchive path ${path}`)
  }
})

await check('OpenAPI exposes public Box ID and keeps internal UUID separate', () => {
  const schemas = openapi.components?.schemas || {}
  const sandbox = schemas.Sandbox || schemas.SandboxDto
  const box = schemas.Box || schemas.BoxResponseDto

  assert(sandbox, 'Sandbox schema is missing')
  assert(sandbox.properties?.id, 'Sandbox.id is missing')
  assert(sandbox.properties?.boxId, 'Sandbox.boxId is missing')
  assert(
    String(sandbox.properties.id.description || '')
      .toLowerCase()
      .includes('internal uuid'),
    'Sandbox.id is not documented as the internal UUID',
  )
  assert(!sandbox.properties?.autoArchiveInterval, 'Sandbox schema still exposes autoArchiveInterval')

  assert(box, 'Box schema is missing')
  assert(box.properties?.box_id, 'Box.box_id is missing')
  assert(!box.properties?.id, 'Box schema should not expose the internal UUID as id')
})

await check('OpenAPI removes autostop/autodelete/autoarchive endpoints', () => {
  const paths = normalizedPaths(openapi)
  assert(!paths.has('/sandbox/{sandboxIdOrName}/autostop/{interval}'), 'autostop endpoint is still present')
  assert(!paths.has('/sandbox/{sandboxIdOrName}/autodelete/{interval}'), 'autodelete endpoint is still present')
  assert(!paths.has('/sandbox/{sandboxIdOrName}/autoarchive/{interval}'), 'autoarchive endpoint is still present')
  assert(!paths.has('/sandbox/{sandboxIdOrName}/archive'), 'archive endpoint is still present')
})

if (!skipConfig) {
  await check('dev /config no longer returns auto-archive config', async () => {
    const config = await fetchJson(`${apiUrl}/config`)
    assertNoKey(config, 'maxAutoArchiveInterval')
    assertNoKey(config, 'autoArchiveInterval')
  })
} else {
  skip('Config endpoint check skipped by BOXLITE_E2E_SKIP_CONFIG=true')
}

if (!skipDashboard) {
  await check('dashboard bundle does not contain archive UI strings', async () => {
    const bundleText = await fetchDashboardTextBundle(dashboardUrl)
    for (const token of forbiddenDashboardTokens) {
      assert(!bundleText.includes(token), `Dashboard bundle still contains ${token}`)
    }
  })
} else {
  skip('Dashboard bundle check skipped by BOXLITE_E2E_SKIP_DASHBOARD=true')
}

if (!skipHttpProbes) {
  await check('archive endpoints are unavailable over HTTP', async () => {
    const headers = apiKey ? authHeaders() : undefined
    await assertUnavailable(`${apiUrl}/sandbox/e2e-missing-box/archive`, headers)
    await assertUnavailable(`${apiUrl}/sandbox/e2e-missing-box/autoarchive/30`, headers)
  })
} else {
  skip('HTTP archive endpoint probes skipped by BOXLITE_E2E_SKIP_HTTP_PROBES=true')
}

if (apiKey) {
  await check('Box ID end-to-end create/detail/list/REST/delete flow', runBoxIdFlow)
} else if (requireApiKey) {
  await check('Box ID end-to-end create/detail/list/REST/delete flow', () => {
    throw new Error('BOXLITE_E2E_API_KEY or BOXLITE_API_KEY is required')
  })
} else {
  skip('Box ID create/detail/list/REST flow skipped because no BOXLITE_E2E_API_KEY or BOXLITE_API_KEY was provided')
}

console.log('')
console.log(`dev smoke summary: ${failures === 0 ? 'passed' : 'failed'} (${skipped} skipped)`)
if (failures > 0) {
  process.exit(1)
}

async function runBoxIdFlow() {
  const name = `e2e-boxid-${Date.now()}`
  let created

  try {
    created = await fetchJson(`${apiUrl}/sandbox`, {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        name,
        labels: {
          'boxlite.io/e2e': 'box-id',
        },
        autoPauseInterval: 300,
        autoDeleteInterval: 3600,
      }),
    })

    assertSandboxIdentity(created, 'create response')
    assertNoKey(created, 'autoArchiveInterval')

    const detail = await fetchJson(`${apiUrl}/sandbox/${encodeURIComponent(created.boxId)}`, {
      headers: authHeaders(),
    })
    assertEqual(detail.id, created.id, 'detail by boxId returns the same internal UUID')
    assertEqual(detail.boxId, created.boxId, 'detail by boxId returns the same public Box ID')
    assertNoKey(detail, 'autoArchiveInterval')

    const list = await fetchJson(`${apiUrl}/sandbox/paginated?id=${encodeURIComponent(created.boxId)}&limit=20`, {
      headers: authHeaders(),
    })
    const listItem = list.items?.find((item) => item.id === created.id)
    assert(listItem, 'paginated list did not find the created sandbox by Box ID filter')
    assertEqual(listItem.boxId, created.boxId, 'paginated list item keeps public Box ID')
    assertNoKey(listItem, 'autoArchiveInterval')

    const box = await fetchJson(`${apiUrl}/v1/boxes/${encodeURIComponent(created.boxId)}`, {
      headers: authHeaders(),
    })
    assertEqual(box.box_id, created.boxId, 'REST box_id is the public Box ID')
    assert(!isUuid(box.box_id), 'REST box_id must not be the internal UUID')
    assertNoKey(box, 'autoArchiveInterval')

    await assertUnavailable(`${apiUrl}/sandbox/${encodeURIComponent(created.boxId)}/archive`, authHeaders())
    await assertUnavailable(`${apiUrl}/sandbox/${encodeURIComponent(created.boxId)}/autoarchive/30`, authHeaders())
  } finally {
    if (created?.id) {
      await cleanupSandbox(created.id)
    }
  }
}

function assertSandboxIdentity(value, label) {
  assert(value, `${label} is empty`)
  assert(isUuid(value.id), `${label} id is not a UUID: ${value.id}`)
  assert(isBoxId(value.boxId), `${label} boxId is not a 12-character public Box ID: ${value.boxId}`)
  assert(value.id !== value.boxId, `${label} id and boxId must be distinct`)
}

async function cleanupSandbox(sandboxId) {
  try {
    const response = await fetchWithTimeout(`${apiUrl}/sandbox/${encodeURIComponent(sandboxId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (![200, 202, 204, 404].includes(response.status)) {
      const body = await response.text()
      console.warn(`cleanup returned ${response.status}: ${body.slice(0, 300)}`)
    }
  } catch (error) {
    console.warn(`cleanup failed for ${sandboxId}: ${error.message}`)
  }
}

async function assertUnavailable(url, headers) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
  })
  assert(
    [404, 405].includes(response.status),
    `${url} should be unavailable; got HTTP ${response.status}. A 401 usually means the route still exists behind auth.`,
  )
}

async function loadOpenApi() {
  if (openapiFile) {
    return JSON.parse(fs.readFileSync(openapiFile, 'utf8'))
  }
  return fetchJson(openapiUrl)
}

async function fetchDashboardTextBundle(rootUrl) {
  const html = await fetchText(rootUrl)
  const assetUrls = new Set()
  const attrPattern = /\s(?:src|href)=["']([^"']+)["']/g
  let match

  while ((match = attrPattern.exec(html))) {
    const assetUrl = new URL(match[1], rootUrl).toString()
    if (/\.(js|css|html)(\?|$)/.test(assetUrl)) {
      assetUrls.add(assetUrl)
    }
  }

  const parts = [html]
  for (const assetUrl of assetUrls) {
    parts.push(await fetchText(assetUrl))
  }
  return parts.join('\n')
}

function normalizedPaths(spec) {
  return new Set(
    Object.keys(spec.paths || {}).map((path) => {
      if (path === '/api') return '/'
      return path.replace(/^\/api(?=\/)/, '')
    }),
  )
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${url} did not return JSON: ${text.slice(0, 500)}`)
  }
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return text
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.BOXLITE_E2E_TIMEOUT_MS || 30000))
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function check(label, fn) {
  try {
    await fn()
    console.log(`ok - ${label}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${label}`)
    console.error(`  ${error.message}`)
  }
}

function skip(label) {
  skipped += 1
  console.log(`skip - ${label}`)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message}; expected ${expected}, got ${actual}`)
}

function assertNoKey(value, key) {
  const paths = findKeyPaths(value, key)
  assert(paths.length === 0, `${key} is still present at ${paths.join(', ')}`)
}

function findKeyPaths(value, key, path = '$', results = []) {
  if (!value || typeof value !== 'object') {
    return results
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = `${path}.${childKey}`
    if (childKey === key) {
      results.push(childPath)
    }
    findKeyPaths(childValue, key, childPath, results)
  }
  return results
}

function jsonAuthHeaders() {
  return {
    ...authHeaders(),
    'content-type': 'application/json',
  }
}

function authHeaders() {
  return {
    authorization: `Bearer ${apiKey}`,
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function isBoxId(value) {
  return /^[0-9A-Za-z]{12}$/.test(String(value || ''))
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}
