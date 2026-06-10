#!/usr/bin/env node

const API_BASE = 'https://api.clickhouse.cloud/v1'
const DEFAULT_DASHBOARD_NAME = 'BoxLite Admin Diagnose'

const args = new Set(process.argv.slice(2))

function usage() {
  console.log(`Usage:
  node apps/scripts/clickstack-cloud.mjs sources
  node apps/scripts/clickstack-cloud.mjs env
  node apps/scripts/clickstack-cloud.mjs ensure-dashboard [--replace]

Required env:
  CLICKHOUSE_CLOUD_ORG_ID
  CLICKHOUSE_CLOUD_SERVICE_ID
  CLICKHOUSE_CLOUD_API_KEY_ID
  CLICKHOUSE_CLOUD_API_KEY_SECRET

Optional env:
  ADMIN_OBSERVABILITY_CLICKSTACK_URL
  CLICKSTACK_DASHBOARD_NAME

This script never prints API key secrets.`)
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function config() {
  return {
    organizationId: requiredEnv('CLICKHOUSE_CLOUD_ORG_ID'),
    serviceId: requiredEnv('CLICKHOUSE_CLOUD_SERVICE_ID'),
    keyId: requiredEnv('CLICKHOUSE_CLOUD_API_KEY_ID'),
    keySecret: requiredEnv('CLICKHOUSE_CLOUD_API_KEY_SECRET'),
    clickstackUrl:
      process.env.ADMIN_OBSERVABILITY_CLICKSTACK_URL ||
      `https://hyperdx.clickhouse.cloud/search?chcServiceId=${process.env.CLICKHOUSE_CLOUD_SERVICE_ID}`,
    dashboardName: process.env.CLICKSTACK_DASHBOARD_NAME || DEFAULT_DASHBOARD_NAME,
  }
}

function authHeader({ keyId, keySecret }) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`
}

async function cloudRequest(cfg, path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  const bodyText = await response.text()
  const body = bodyText ? JSON.parse(bodyText) : {}
  if (!response.ok) {
    const message = body.error || response.statusText
    throw new Error(`ClickHouse Cloud API ${response.status} ${message}`)
  }
  return body.result ?? body
}

function clickstackPath(cfg, suffix) {
  return `/organizations/${cfg.organizationId}/services/${cfg.serviceId}/clickstack${suffix}`
}

async function listSources(cfg) {
  return cloudRequest(cfg, clickstackPath(cfg, '/sources'))
}

async function listDashboards(cfg) {
  return cloudRequest(cfg, clickstackPath(cfg, '/dashboards'))
}

function sourceScore(source, kind, preferredNames) {
  if (source.kind !== kind) return -1
  const name = String(source.name || '').toLowerCase()
  if (preferredNames.some((preferred) => name === preferred)) return 3
  if (preferredNames.some((preferred) => name.includes(preferred))) return 2
  return 1
}

function pickSource(sources, kind, preferredNames) {
  return [...sources]
    .map((source) => ({ source, score: sourceScore(source, kind, preferredNames) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.source
}

function pickBoxLiteSources(sources) {
  return {
    logs: pickSource(sources, 'log', ['boxlite logs', 'logs']),
    traces: pickSource(sources, 'trace', ['boxlite traces', 'traces']),
    metrics: pickSource(sources, 'metric', ['boxlite metrics', 'metrics']),
  }
}

function dashboardUrl(cfg, dashboardId) {
  const url = new URL(cfg.clickstackUrl)
  url.pathname = `/dashboards/${dashboardId}`
  url.searchParams.set('chcServiceId', cfg.serviceId)
  return url.toString()
}

function printDashboardEnv(url) {
  console.log(`export ADMIN_OBSERVABILITY_CLICKSTACK_DASHBOARD_URL="${url}"`)
}

function printSources(sources) {
  const rows = sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    database: source.from?.databaseName,
    table: source.from?.tableName || '',
  }))
  console.table(rows)
}

function printEnv(cfg, sources) {
  const picked = pickBoxLiteSources(sources)
  const missing = Object.entries(picked)
    .filter(([, source]) => !source)
    .map(([kind]) => kind)

  console.log(`export ADMIN_OBSERVABILITY_CLICKSTACK_URL="${cfg.clickstackUrl}"`)
  if (picked.logs) {
    console.log(`export ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID="${picked.logs.id}"`)
  }
  if (picked.traces) {
    console.log(`export ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID="${picked.traces.id}"`)
  }
  if (picked.metrics) {
    console.log(`export ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID="${picked.metrics.id}"`)
  }

  if (missing.length > 0) {
    console.error(`Missing ClickStack sources: ${missing.join(', ')}`)
    process.exitCode = 2
  }
}

function lineTile({ name, x, y, sourceId, where }) {
  return {
    name,
    x,
    y,
    w: 12,
    h: 8,
    config: {
      displayType: 'line',
      sourceId,
      asRatio: false,
      alignDateRangeToGranularity: true,
      fillNulls: true,
      select: [
        {
          aggFn: 'count',
          where,
          whereLanguage: 'sql',
        },
      ],
    },
  }
}

function dashboardPayload(cfg, sources) {
  const picked = pickBoxLiteSources(sources)
  const tiles = []
  if (picked.logs) {
    tiles.push(
      lineTile({
        name: 'Log Events',
        x: 0,
        y: 0,
        sourceId: picked.logs.id,
        where: "ServiceName != ''",
      }),
    )
  }
  if (picked.traces) {
    tiles.push(
      lineTile({
        name: 'Trace Spans',
        x: 12,
        y: 0,
        sourceId: picked.traces.id,
        where: "ServiceName != ''",
      }),
    )
  }

  if (tiles.length === 0) {
    throw new Error('No log or trace ClickStack source was found; cannot create dashboard')
  }

  return {
    name: cfg.dashboardName,
    tags: ['boxlite', 'admin', 'observability'],
    savedQuery: "ServiceName != ''",
    savedQueryLanguage: 'sql',
    tiles,
  }
}

async function ensureDashboard(cfg) {
  const [sources, dashboards] = await Promise.all([listSources(cfg), listDashboards(cfg)])
  const existing = dashboards.find((dashboard) => dashboard.name === cfg.dashboardName)
  const payload = dashboardPayload(cfg, sources)

  if (existing && !args.has('--replace')) {
    console.log(`Dashboard exists: ${existing.name}`)
    console.log(`id=${existing.id}`)
    const url = dashboardUrl(cfg, existing.id)
    console.log(`url=${url}`)
    printDashboardEnv(url)
    return
  }

  if (existing && args.has('--replace')) {
    const result = await cloudRequest(cfg, clickstackPath(cfg, `/dashboards/${existing.id}`), {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    console.log(`Dashboard updated: ${result.name}`)
    console.log(`id=${result.id}`)
    const url = dashboardUrl(cfg, result.id)
    console.log(`url=${url}`)
    printDashboardEnv(url)
    return
  }

  const result = await cloudRequest(cfg, clickstackPath(cfg, '/dashboards'), {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  console.log(`Dashboard created: ${result.name}`)
  console.log(`id=${result.id}`)
  const url = dashboardUrl(cfg, result.id)
  console.log(`url=${url}`)
  printDashboardEnv(url)
}

async function main() {
  const command = process.argv[2]
  if (!command || args.has('--help') || args.has('-h')) {
    usage()
    return
  }

  const cfg = config()
  if (command === 'sources') {
    printSources(await listSources(cfg))
  } else if (command === 'env') {
    printEnv(cfg, await listSources(cfg))
  } else if (command === 'ensure-dashboard') {
    await ensureDashboard(cfg)
  } else {
    usage()
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
