#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.argv[2] || process.env.BOXLITE_DASHBOARD_BASE_URL || 'https://dev.boxlite.ai')
const routePath = normalizePath(process.env.BOXLITE_DASHBOARD_SMOKE_ROUTE || '/dashboard/boxes')
const timeoutMs = Number(process.env.BOXLITE_DASHBOARD_SMOKE_TIMEOUT_MS || 15000)
const checkLegacyRootAssets =
  process.env.BOXLITE_DASHBOARD_CHECK_LEGACY_ROOT === undefined
    ? baseUrl.hostname !== 'boxlite.ai'
    : process.env.BOXLITE_DASHBOARD_CHECK_LEGACY_ROOT === 'true'

const checks = []
let failures = 0
let skipped = 0

const html = await check(`dashboard route returns HTML without redirect: ${routePath}`, async () => {
  const response = await fetchNoRedirect(routePath)
  assert(response.status === 200, `${routePath} returned HTTP ${response.status}`)
  assert(isHtml(response), `${routePath} did not return HTML: ${response.headers.get('content-type') || '(missing)'}`)
  return await response.text()
})

const refs = extractLocalRefs(html)
const dashboardRefs = refs.filter((ref) => ref.startsWith('/dashboard/'))
const dashboardAssetRefs = dashboardRefs.filter((ref) => ref.startsWith('/dashboard/assets/'))
const rootDashboardRefs = refs.filter(isRootDashboardRef)

await check('HTML points dashboard resources at /dashboard/*', () => {
  assert(dashboardAssetRefs.some((ref) => /\.js(?:\?|$)/.test(ref)), 'missing /dashboard/assets/*.js reference')
  assert(dashboardAssetRefs.some((ref) => /\.css(?:\?|$)/.test(ref)), 'missing /dashboard/assets/*.css reference')
  assert(dashboardRefs.includes('/dashboard/icon.svg'), 'missing /dashboard/icon.svg reference')
  assert(dashboardRefs.includes('/dashboard/favicon.ico'), 'missing /dashboard/favicon.ico reference')
  assert(dashboardRefs.includes('/dashboard/apple-touch-icon.png'), 'missing /dashboard/apple-touch-icon.png reference')
})

await check('HTML no longer references root dashboard assets', () => {
  assert(
    rootDashboardRefs.length === 0,
    `found root dashboard asset refs that would break behind boxlite.ai/dashboard: ${rootDashboardRefs.join(', ')}`,
  )
})

for (const ref of sortedUnique(dashboardRefs)) {
  await check(`new dashboard resource is reachable: ${ref}`, async () => {
    const response = await fetchNoRedirect(ref)
    assert(response.status === 200, `${ref} returned HTTP ${response.status}`)
    if (ref.startsWith('/dashboard/assets/')) {
      assert(
        /immutable/i.test(response.headers.get('cache-control') || ''),
        `${ref} should use immutable Cache-Control; got ${response.headers.get('cache-control') || '(missing)'}`,
      )
    }
  })
}

await check('deep /dashboard/* route falls back to SPA HTML', async () => {
  const fallbackPath = `/dashboard/__subpath_smoke_${Date.now()}`
  const response = await fetchNoRedirect(fallbackPath)
  assert(response.status === 200, `${fallbackPath} returned HTTP ${response.status}`)
  assert(isHtml(response), `${fallbackPath} did not return HTML: ${response.headers.get('content-type') || '(missing)'}`)
})

if (checkLegacyRootAssets) {
  for (const ref of sortedUnique(dashboardAssetRefs)) {
    const legacyRef = ref.replace(/^\/dashboard/, '')
    await check(`legacy root asset remains reachable: ${legacyRef}`, async () => {
      const response = await fetchNoRedirect(legacyRef)
      assert(response.status === 200, `${legacyRef} returned HTTP ${response.status}`)
    })
  }
} else {
  skip('legacy root asset checks skipped for boxlite.ai public website host')
}

console.log('')
for (const item of checks) {
  console.log(`${item.ok ? 'ok' : 'not ok'} - ${item.label}`)
  if (!item.ok) {
    console.log(`  ${item.error}`)
  }
}
console.log('')
console.log(`dashboard subpath smoke: ${failures === 0 ? 'passed' : 'failed'} (${skipped} skipped)`)

if (failures > 0) {
  process.exit(1)
}

async function check(label, fn) {
  try {
    const value = await fn()
    checks.push({ label, ok: true })
    return value
  } catch (error) {
    failures += 1
    checks.push({ label, ok: false, error: error.message })
    return undefined
  }
}

function skip(label) {
  skipped += 1
  checks.push({ label, ok: true })
}

async function fetchNoRedirect(pathOrUrl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL(pathOrUrl, baseUrl)
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        accept: '*/*',
      },
    })
    assert(!isRedirect(response), `${url} redirected with HTTP ${response.status} to ${response.headers.get('location')}`)
    return response
  } finally {
    clearTimeout(timer)
  }
}

function extractLocalRefs(htmlText) {
  if (!htmlText) return []
  const refs = []
  const attrPattern = /\s(?:src|href)=["']([^"']+)["']/g
  let match
  while ((match = attrPattern.exec(htmlText))) {
    const rawRef = match[1]
    if (!rawRef.startsWith('/')) continue
    refs.push(new URL(rawRef, baseUrl).pathname)
  }
  return sortedUnique(refs)
}

function isRootDashboardRef(ref) {
  return ref.startsWith('/assets/') || ref === '/icon.svg' || ref === '/favicon.ico' || ref === '/apple-touch-icon.png'
}

function isRedirect(response) {
  return response.status >= 300 && response.status < 400
}

function isHtml(response) {
  return /text\/html/i.test(response.headers.get('content-type') || '')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function normalizeBaseUrl(value) {
  const url = new URL(value)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url
}

function normalizePath(value) {
  return value.startsWith('/') ? value : `/${value}`
}
