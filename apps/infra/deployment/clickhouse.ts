// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

type ClickHouseMode = 'self-hosted' | 'managed' | 'disabled'

export type ClickHouseConfig =
  | { mode: 'self-hosted'; active: true }
  | { mode: 'managed'; active: true; url: string; writerSecretArn: string; readerSecretArn: string }
  | { mode: 'disabled'; active: false }

const MODES = new Set<ClickHouseMode>(['self-hosted', 'managed', 'disabled'])
const CREDENTIAL_QUERY_KEYS = new Set(['access_token', 'api_key', 'password', 'token', 'user', 'username'])
const HTTP_ORIGIN = /^https?:\/\/[^/?#\\]+\/?$/i
const MANAGED_KEYS = [
  'CLICKHOUSE_URL',
  'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
  'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
]
export const CLICKHOUSE_STAGE_CONFIG_KEYS = Object.freeze([
  'CLICKHOUSE_MODE',
  ...MANAGED_KEYS,
])
export const CLICKHOUSE_REMOVED_STAGE_CONFIG_KEYS = Object.freeze([
  'CLICKHOUSE_SELF_HOSTED_INSTANCE_TYPE',
  'CLICKHOUSE_SELF_HOSTED_DATA_GB',
  'CLICKHOUSE_RETENTION_HOURS',
  'CLICKHOUSE_WRITER_USERNAME',
  'CLICKHOUSE_READER_USERNAME',
  'CLICKHOUSE_DATABASE',
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
])

function isSet(environment: NodeJS.ProcessEnv, name: string) {
  return Boolean(environment[name]?.trim())
}

function rejectSet(environment: NodeJS.ProcessEnv, keys: readonly string[], message: string) {
  const configured = keys.find((key) => isSet(environment, key))
  if (configured) throw new Error(`${configured} ${message}`)
}

function modeValue(environment: NodeJS.ProcessEnv) {
  const value = environment.CLICKHOUSE_MODE?.trim() || 'self-hosted'
  if (!MODES.has(value as ClickHouseMode)) {
    throw new Error(`CLICKHOUSE_MODE must be one of ${[...MODES].join(', ')}, got '${value}'`)
  }
  return value as ClickHouseMode
}

function httpUrl(value: string, name: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`)
  }
  const hasCredentialQuery = [...parsed.searchParams.keys()].some((key) =>
    CREDENTIAL_QUERY_KEYS.has(key.toLowerCase()),
  )
  if (parsed.username || parsed.password || hasCredentialQuery) {
    throw new Error(`${name} cannot contain credentials`)
  }
  if (!HTTP_ORIGIN.test(value)) {
    throw new Error(`${name} must be an origin URL without a path, query, or fragment`)
  }
  return parsed.origin
}

/** Keep managed secrets inside the exact Secrets Manager namespace the runtime role can read. */
export function requireClickHouseSecretArn(
  name: string,
  value: string,
  scope: { region: string; accountId: string; appName: string; stage: string },
) {
  const { region, accountId, appName, stage } = scope
  const prefix = `arn:aws:secretsmanager:${region}:${accountId}:secret:${appName}-${stage}-`
  const arnParts = value.split(':')
  const secretName = arnParts[6]
  if (!value.startsWith(prefix) || arnParts.length !== 7 || secretName === `${appName}-${stage}-`) {
    throw new Error(`${name} must be a same-stage Secrets Manager ARN (${prefix}*)`)
  }
  return value
}

/** Resolve the complete ClickHouse topology before SST declares resources. */
export function resolveClickHouseConfig(environment: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  rejectSet(environment, CLICKHOUSE_REMOVED_STAGE_CONFIG_KEYS, 'is not supported')

  const mode = modeValue(environment)

  if (mode === 'disabled') {
    rejectSet(environment, MANAGED_KEYS, 'cannot be set when CLICKHOUSE_MODE=disabled')
    return { mode, active: false }
  }

  if (mode === 'self-hosted') {
    rejectSet(environment, MANAGED_KEYS, 'cannot be set when CLICKHOUSE_MODE=self-hosted')
    return { mode, active: true }
  }

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
  if (writerSecretArn === readerSecretArn) {
    throw new Error('managed ClickHouse writer and reader secrets must be different')
  }
  return {
    mode,
    active: true,
    url: httpUrl(url, 'CLICKHOUSE_URL'),
    writerSecretArn,
    readerSecretArn,
  }
}
