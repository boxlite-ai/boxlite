#!/usr/bin/env node

const DEFAULT_API_URL = 'https://api.dev.boxlite.ai/api'
const AGENT_SOURCE = 'agent'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  usage()
  process.exit(0)
}

const apiUrl = stripTrailingSlash(
  args.apiUrl ||
    process.env.BOXLITE_ADMIN_API_URL ||
    process.env.BOXLITE_E2E_API_URL ||
    process.env.BOXLITE_API_URL ||
    DEFAULT_API_URL,
)
const apiKey =
  args.apiKey || process.env.BOXLITE_ADMIN_API_KEY || process.env.ADMIN_API_KEY || process.env.BOXLITE_API_KEY
const windowRange = buildWindow(args)
const target = buildTarget(args)

if (!apiKey) {
  console.error('Missing Admin API credential.')
  console.error('Set BOXLITE_ADMIN_API_KEY, ADMIN_API_KEY, or BOXLITE_API_KEY.')
  process.exit(2)
}

try {
  const status = await fetchJson('/admin/observability/status', {
    searchParams: windowRange,
  })
  printStatus(status)

  const failures = []
  if (args.assert) {
    assertStatus(status, failures)
  }

  if (Object.keys(target).length === 0) {
    if (args.assert) {
      failures.push('contract requires an investigation target id (e.g. --sandbox-id); status-only is not a contract')
      reportContract(failures)
    }
    console.log('')
    console.log('No investigation target was provided; status-only smoke completed.')
    console.log(
      'Pass --trace-id, --box-id, --sandbox-id, --runner-id, --machine-id, --request-id, --operation-id, --execution-id, or --job-id for full agent context smoke.',
    )
    process.exit(0)
  }

  const investigation = await fetchJson('/admin/observability/investigate', {
    searchParams: {
      ...windowRange,
      limit: args.limit || '100',
      ...target,
    },
  })
  printInvestigation(investigation)

  if (args.assert) {
    await assertInvestigation(investigation, failures)
    reportContract(failures)
  }
} catch (error) {
  console.error(`Agent observability smoke failed: ${error.message}`)
  process.exit(1)
}

function usage() {
  console.log(`Usage:
  yarn observability:agent-smoke [options]

Examples:
  ADMIN_API_KEY=$KEY yarn observability:agent-smoke -- --trace-id 150a1a11bbc660bcd0191b2aeacd5ed0
  ADMIN_API_KEY=$KEY yarn observability:agent-smoke -- --box-id otohwPq5sfN5 --hours 3
  BOXLITE_ADMIN_API_URL=https://api.dev.boxlite.ai/api ADMIN_API_KEY=$KEY yarn observability:agent-smoke -- --runner-id <runner-id>

Options:
  --api-url <url>       Admin API base URL. Default: ${DEFAULT_API_URL}
  --api-key <key>       Admin API key. Prefer env vars so secrets do not enter shell history.
  --from <iso>          ISO start time. Default: now - --hours.
  --to <iso>            ISO end time. Default: now.
  --hours <n>           Lookback hours when --from is omitted. Default: 1.
  --limit <n>           Investigation result limit. Default: 100.
  --trace-id <id>
  --org-id <id>
  --user-id <id>
  --box-id <id>
  --sandbox-id <id>
  --runner-id <id>
  --machine-id <id>
  --request-id <id>
  --operation-id <id>
  --execution-id <id>
  --job-id <id>

This is an internal Admin/Ai-Agent smoke. It only calls BoxLite Admin API with X-BoxLite-Source=agent.
It never connects directly to ClickHouse, ClickStack, CloudWatch, or S3, and never prints API key secrets.`)
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }
    if (arg === '--assert') {
      parsed.assert = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2)
    const key = toCamelCase(rawKey)
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (value === undefined || value.startsWith?.('--')) {
      throw new Error(`Missing value for --${rawKey}`)
    }
    parsed[key] = value
  }
  return parsed
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function buildWindow({ from, to, hours }) {
  const end = to ? new Date(to) : new Date()
  const lookbackHours = hours ? Number(hours) : 1
  const start = from ? new Date(from) : new Date(end.getTime() - lookbackHours * 60 * 60 * 1000)
  assertValidDate(start, 'from')
  assertValidDate(end, 'to')
  return {
    from: start.toISOString(),
    to: end.toISOString(),
  }
}

function assertValidDate(value, label) {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid ${label} date`)
  }
}

function buildTarget(values) {
  const target = {}
  append(target, 'traceId', values.traceId)
  append(target, 'orgId', values.orgId)
  append(target, 'userId', values.userId)
  append(target, 'boxId', values.boxId)
  append(target, 'sandboxId', values.sandboxId)
  append(target, 'runnerId', values.runnerId)
  append(target, 'machineId', values.machineId)
  append(target, 'requestId', values.requestId)
  append(target, 'operationId', values.operationId)
  append(target, 'executionId', values.executionId)
  append(target, 'jobId', values.jobId)
  return target
}

function append(target, key, value) {
  if (value) {
    target[key] = value
  }
}

async function fetchJson(path, { searchParams }) {
  const url = new URL(`${apiUrl}${path}`)
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-BoxLite-Source': AGENT_SOURCE,
    },
  })
  const bodyText = await response.text()
  const body = bodyText ? parseJson(bodyText) : {}
  if (!response.ok) {
    const message = body?.message || body?.error || response.statusText
    throw new Error(`${response.status} ${message} (${url.pathname})`)
  }
  return body
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function printStatus(status) {
  console.log('Agent source header: X-BoxLite-Source=agent')
  console.log(`Admin API: ${apiUrl}`)
  console.log('')
  console.log('Status')
  console.log(
    `- backend: ${status.backend?.state ?? 'unknown'}${status.backend?.message ? ` (${status.backend.message})` : ''}`,
  )
  for (const layer of status.layers ?? []) {
    const signals = layer.signals ?? {}
    console.log(
      `- ${layer.layer}: ${layer.state} | logs=${signals.logs ?? 'unknown'} traces=${signals.traces ?? 'unknown'} metrics=${signals.metrics ?? 'unknown'}${layer.lastSeen ? ` lastSeen=${layer.lastSeen}` : ''}`,
    )
  }
}

function printInvestigation(investigation) {
  console.log('')
  console.log('Investigation')
  console.log(
    `- resource: ${investigation.resource?.type ?? 'unknown'} / ${investigation.resource?.title ?? 'untitled'}`,
  )
  if (investigation.resource?.subtitle) {
    console.log(`- subtitle: ${investigation.resource.subtitle}`)
  }
  console.log(`- traces: ${investigation.traceSpans?.length ?? 0}`)
  console.log(`- logs: ${investigation.logs?.length ?? 0}`)
  console.log(`- metrics series: ${investigation.metrics?.series?.length ?? 0}`)
  console.log(
    `- boxes/runners/machines: ${investigation.boxes?.length ?? 0}/${investigation.runners?.length ?? 0}/${investigation.machines?.length ?? 0}`,
  )
  console.log(
    `- audit/xLog/s3: ${investigation.auditLogs?.length ?? 0}/${investigation.xlogs?.length ?? 0}/${investigation.s3Objects?.length ?? 0}`,
  )
  console.log(`- timeline: ${investigation.timeline?.length ?? 0}`)

  console.log('')
  console.log('Sources')
  for (const source of investigation.sources ?? []) {
    const suffix = source.message ? ` (${source.message})` : source.count !== undefined ? ` (${source.count})` : ''
    console.log(`- ${source.source}: ${source.state}${suffix}`)
  }

  console.log('')
  console.log('Correlation')
  for (const [key, values] of Object.entries(investigation.correlation ?? {})) {
    if (Array.isArray(values) && values.length > 0) {
      console.log(`- ${key}: ${values.slice(0, 5).join(', ')}${values.length > 5 ? ` +${values.length - 5}` : ''}`)
    }
  }

  const clickstack = investigation.externalLinks?.clickstack
  if (clickstack?.configured) {
    console.log('')
    console.log('ClickStack links')
    if (clickstack.dashboardUrl) console.log(`- dashboard: ${clickstack.dashboardUrl}`)
    if (clickstack.logsUrl) console.log(`- logs: ${clickstack.logsUrl}`)
    if (clickstack.tracesUrl) console.log(`- traces: ${clickstack.tracesUrl}`)
    if (clickstack.metricsUrl) console.log(`- metrics: ${clickstack.metricsUrl}`)
  }

  if (investigation.commands?.aiAgentPrompt) {
    console.log('')
    console.log('Server-provided AI Agent prompt')
    console.log(investigation.commands.aiAgentPrompt)
  }
}

function assertStatus(status, failures) {
  if (!status?.backend?.state) failures.push('status: backend.state missing')
  const layers = status?.layers ?? []
  if (layers.length === 0) failures.push('status: no layers reported')
  if (!layers.some((layer) => layer.state === 'receiving')) {
    failures.push('status: no layer is receiving telemetry')
  }
}

async function assertInvestigation(investigation, failures) {
  // reverse lookup must resolve a concrete resource from id + window (no traceId needed)
  if (!investigation?.resource?.type) {
    failures.push('investigate: resource.type missing (reverse lookup did not resolve a resource)')
  }
  const correlation = investigation?.correlation ?? {}
  const resolvedAnyId = Object.values(correlation).some((value) => Array.isArray(value) && value.length > 0)
  if (!resolvedAnyId) failures.push('investigate: correlation resolved no ids')
  if (!Array.isArray(investigation?.sources) || investigation.sources.length === 0) {
    failures.push('investigate: sources[] missing (no per-source provenance)')
  }
  if (!Array.isArray(investigation?.timeline)) failures.push('investigate: timeline missing')

  // drill-down + trace truth-check (only when the aggregator vetted a trace)
  const traceId = correlation.traceIds?.[0]
  if (traceId) {
    const spans = await fetchJson(`/admin/observability/traces/${encodeURIComponent(traceId)}`, {
      searchParams: windowRange,
    })
    const list = Array.isArray(spans) ? spans : (spans?.items ?? [])
    if (list.length === 0) {
      failures.push(`drill-down: /traces/${traceId} returned no spans`)
    } else {
      const looksDiagnostic = list.every((span) => {
        const route = span.spanAttributes?.['http.route'] || span.spanName || ''
        return String(route).includes('/admin/observability')
      })
      if (looksDiagnostic) {
        failures.push(`trace truth-check: trace ${traceId} is a diagnostic call, not a subject trace`)
      }
      // post-C1 contract: when a span carries serviceName, its layer must resolve to a known layer
      const known = new Set(['api', 'runner', 'ec2_host', 'box'])
      const badLayer = list.find((span) => span.serviceName && span.layer && !known.has(span.layer))
      if (badLayer) {
        failures.push(`span layer attribution: unexpected layer "${badLayer.layer}" for service ${badLayer.serviceName}`)
      }
    }
  }

  const clickstack = investigation?.externalLinks?.clickstack
  if (clickstack?.configured && !clickstack.dashboardUrl && !clickstack.logsUrl && !clickstack.tracesUrl) {
    failures.push('clickstack: configured but no deep links present')
  }
}

function reportContract(failures) {
  console.log('')
  if (failures.length === 0) {
    console.log('CONTRACT PASS: agent observability behaviors verified (reverse lookup, correlation, sources, drill-down, links).')
    process.exit(0)
  }
  console.error('CONTRACT FAIL:')
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
