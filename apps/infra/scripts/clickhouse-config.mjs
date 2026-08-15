// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const MODES = new Set(['self-hosted', 'managed', 'disabled'])
const MANAGED_KEYS = [
  'CLICKHOUSE_URL',
  'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
  'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
  'CLICKHOUSE_WRITER_USERNAME',
  'CLICKHOUSE_READER_USERNAME',
  'CLICKHOUSE_DATABASE',
]
const SELF_HOSTED_KEYS = ['CLICKHOUSE_SELF_HOSTED_INSTANCE_TYPE', 'CLICKHOUSE_SELF_HOSTED_DATA_GB']
export const CLICKHOUSE_STAGE_CONFIG_KEYS = Object.freeze([
  'CLICKHOUSE_MODE',
  ...MANAGED_KEYS,
  ...SELF_HOSTED_KEYS,
  'CLICKHOUSE_RETENTION_HOURS',
])
const REMOVED_KEYS = [
  'CLICKHOUSE_WRITER_ACTIVATION',
  'CLICKHOUSE_READER_ACTIVATION',
  'CLICKHOUSE_ACTIVATION',
  'CLICKHOUSE_ALLOW_DESTROY',
  'CLICKHOUSE_ALLOW_DATA_DESTROY',
  'CLICKHOUSE_FINAL_SNAPSHOT_ID',
  'CLICKHOUSE_RECOVERY_SNAPSHOT_ID',
  'CLICKHOUSE_REPLACEMENT_TOKEN',
  'CLICKHOUSE_EXPORTER_ENABLED',
  'CLICKHOUSE_PASSWORD',
  'CLICKHOUSE_WRITER_PASSWORD',
  'CLICKHOUSE_READER_PASSWORD',
]

function isSet(environment, name) {
  return Boolean(environment[name]?.trim())
}

function rejectSet(environment, keys, message) {
  const configured = keys.find((key) => isSet(environment, key))
  if (configured) throw new Error(`${configured} ${message}`)
}

function enumValue(environment, name, allowed, fallback) {
  const value = environment[name]?.trim() || fallback
  if (!allowed.has(value)) throw new Error(`${name} must be one of ${[...allowed].join(', ')}, got '${value}'`)
  return value
}

function positiveInteger(environment, name, fallback) {
  const value = environment[name]?.trim() || String(fallback)
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return parsed
}

function httpUrl(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`)
  }
  if (parsed.username || parsed.password) throw new Error(`${name} cannot contain credentials`)
  return value
}

/** Keep managed secrets inside the exact Secrets Manager namespace the runtime role can read. */
export function requireClickHouseSecretArn(name, value, { region, accountId, appName, stage }) {
  const prefix = `arn:aws:secretsmanager:${region}:${accountId}:secret:${appName}-${stage}-`
  if (!value.startsWith(prefix)) {
    throw new Error(`${name} must be a same-stage Secrets Manager ARN (${prefix}*)`)
  }
  return value
}

/** Resolve the complete ClickHouse topology before SST declares resources. */
export function resolveClickHouseConfig(environment = process.env) {
  rejectSet(environment, REMOVED_KEYS, 'is not supported')

  const mode = enumValue(environment, 'CLICKHOUSE_MODE', MODES, 'self-hosted')
  const active = mode !== 'disabled'

  if (mode === 'disabled') {
    rejectSet(
      environment,
      [...MANAGED_KEYS, ...SELF_HOSTED_KEYS, 'CLICKHOUSE_RETENTION_HOURS'],
      'cannot be set when CLICKHOUSE_MODE=disabled',
    )
    return { mode, active }
  }

  if (mode === 'self-hosted') {
    rejectSet(environment, MANAGED_KEYS, 'cannot be set when CLICKHOUSE_MODE=self-hosted')
    return {
      mode,
      active,
      instanceType: environment.CLICKHOUSE_SELF_HOSTED_INSTANCE_TYPE?.trim() || 'm6a.large',
      dataGiB: positiveInteger(environment, 'CLICKHOUSE_SELF_HOSTED_DATA_GB', 50),
      retentionHours: positiveInteger(environment, 'CLICKHOUSE_RETENTION_HOURS', 72),
    }
  }

  rejectSet(environment, [...SELF_HOSTED_KEYS, 'CLICKHOUSE_RETENTION_HOURS'], 'cannot be set when CLICKHOUSE_MODE=managed')
  const url = environment.CLICKHOUSE_URL?.trim()
  const writerSecretArn = environment.CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN?.trim()
  const readerSecretArn = environment.CLICKHOUSE_READER_PASSWORD_SECRET_ARN?.trim()
  if (!url) throw new Error('CLICKHOUSE_URL is required when managed ClickHouse is active')
  if (!writerSecretArn) {
    throw new Error('CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN is required when managed ClickHouse is active')
  }
  if (!readerSecretArn) {
    throw new Error('CLICKHOUSE_READER_PASSWORD_SECRET_ARN is required when managed ClickHouse is active')
  }
  return {
    mode,
    active,
    url: httpUrl(url, 'CLICKHOUSE_URL'),
    writerSecretArn,
    readerSecretArn,
    writerUsername: environment.CLICKHOUSE_WRITER_USERNAME?.trim() || 'otel_writer',
    readerUsername: environment.CLICKHOUSE_READER_USERNAME?.trim() || 'otel_reader',
    database: environment.CLICKHOUSE_DATABASE?.trim() || 'otel',
  }
}
