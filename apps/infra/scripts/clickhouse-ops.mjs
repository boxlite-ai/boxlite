// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const TABLES = [
  'otel_logs',
  'otel_traces',
  'otel_metrics_gauge',
  'otel_metrics_sum',
  'otel_metrics_summary',
  'otel_metrics_histogram',
  'otel_metrics_exponential_histogram',
]

export function buildSelfHostedReadinessCommand({ region, adminSecretArn, writerSecretArn, readerSecretArn, expectedImage, schemaBase64, retentionHours }) {
  if (!region || !adminSecretArn || !writerSecretArn || !readerSecretArn || !expectedImage || !schemaBase64) throw new Error('all readiness inputs are required')
  const describeTables = TABLES.map(
    (table) =>
      `CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --query "DESCRIBE TABLE otel.${table}" >/dev/null`,
  ).join('\n')
  const inserts = TABLES.map((table) => {
    const timestamp = table === 'otel_logs' || table === 'otel_traces' ? 'Timestamp' : 'TimeUnix'
    return `CLICKHOUSE_PASSWORD="$WRITER_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user otel_writer --query "INSERT INTO otel.${table} (${timestamp}) VALUES (now64(9))"`
  }).join('\n')
  const ttlColumns = { otel_logs: 'TimestampTime', otel_traces: 'Timestamp' }
  const reconcileTtl = TABLES.map((table) => {
    const timestamp = ttlColumns[table] || 'TimeUnix'
    return `ALTER TABLE otel.${table} MODIFY TTL toDateTime(${timestamp}) + INTERVAL ${retentionHours} HOUR;`
  }).join('\n')
  return `set -euo pipefail
if ! cloud-init status --wait; then
  tail -n 200 /var/log/clickhouse-setup.log >&2 || true
  exit 1
fi
mountpoint -q /var/lib/boxlite-clickhouse
systemctl restart boxlite-clickhouse
systemctl is-active --quiet boxlite-clickhouse
printf '%s' '${schemaBase64}' | base64 -d > /opt/boxlite-clickhouse/schema.sql
/usr/local/bin/boxlite-clickhouse-sql-users
test "$(docker inspect --format '{{.Config.Image}}' boxlite-clickhouse)" = '${expectedImage}'
ADMIN_PASSWORD=$(aws secretsmanager get-secret-value --region '${region}' --secret-id '${adminSecretArn}' --query SecretString --output text)
WRITER_PASSWORD=$(aws secretsmanager get-secret-value --region '${region}' --secret-id '${writerSecretArn}' --query SecretString --output text)
READER_PASSWORD=$(aws secretsmanager get-secret-value --region '${region}' --secret-id '${readerSecretArn}' --query SecretString --output text)
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -i -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --multiquery < /opt/boxlite-clickhouse/schema.sql
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -i -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --multiquery <<'SQL'
GRANT SELECT, INSERT, SHOW COLUMNS ON otel.* TO otel_writer;
GRANT SELECT, SHOW COLUMNS ON otel.* TO otel_reader;
${reconcileTtl}
SQL
${describeTables}
test "$(CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --query "SELECT count() FROM system.tables WHERE database='otel' AND position(create_table_query, 'toIntervalHour(${retentionHours})') > 0")" = "7"
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --query "SHOW GRANTS FOR otel_writer" | grep -q 'SHOW COLUMNS'
CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user boxlite_admin --query "SHOW GRANTS FOR otel_reader" | grep -q 'SELECT'
${inserts}
CLICKHOUSE_PASSWORD="$READER_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user otel_reader --query "SELECT count() FROM otel.otel_logs" >/dev/null
unset ADMIN_PASSWORD WRITER_PASSWORD READER_PASSWORD`
}

function awsCli(args) {
  try {
    return execFileSync(process.env.AWS_CLI_PATH || 'aws', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message).trim()
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${message}`, { cause: error })
  }
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function isTransientSsmError(error) {
  return /TargetNotConnected|InvalidInstanceId|InvocationDoesNotExist|Throttl|Rate exceeded/i.test(String(error))
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function buildSsmBashCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('SSM Bash command is required')
  return `/usr/bin/env bash -c ${shellLiteral(command)}`
}

function retrySsm(operation, attempts, intervalMs) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return operation()
    } catch (error) {
      lastError = error
      if (!isTransientSsmError(error) || attempt === attempts) throw error
      pause(intervalMs)
    }
  }
  throw lastError
}

export function runSsmCommand({ region, instanceId, command, comment }) {
  const commandId = retrySsm(
    () =>
      awsCli([
        'ssm',
        'send-command',
        '--region',
        region,
        '--instance-ids',
        instanceId,
        '--document-name',
        'AWS-RunShellScript',
        '--comment',
        comment,
        '--parameters',
        JSON.stringify({ commands: [buildSsmBashCommand(command)], executionTimeout: ['900'] }),
        '--query',
        'Command.CommandId',
        '--output',
        'text',
      ]),
    60,
    5_000,
  )

  for (let attempt = 1; attempt <= 90; attempt++) {
    pause(10_000)
    const invocation = JSON.parse(
      retrySsm(
        () =>
          awsCli([
            'ssm',
            'get-command-invocation',
            '--region',
            region,
            '--command-id',
            commandId,
            '--instance-id',
            instanceId,
            '--output',
            'json',
          ]),
        12,
        2_000,
      ),
    )
    if (invocation.Status === 'Success') return invocation
    if (['Cancelled', 'Cancelling', 'Failed', 'TimedOut'].includes(invocation.Status)) {
      throw new Error(
        `${comment}: SSM command ${commandId} ${invocation.Status}: ${invocation.StandardErrorContent || invocation.StandardOutputContent || 'no output'}`,
      )
    }
  }
  throw new Error(`${comment}: SSM command ${commandId} did not finish within 15 minutes`)
}

export function buildWriterSmokeCommand({ region, collectorEndpoint, readerSecretArn }) {
  if (!region || !collectorEndpoint || !readerSecretArn) {
    throw new Error('region, collectorEndpoint, and readerSecretArn are required')
  }
  const marker = `boxlite-clickhouse-smoke-${randomUUID()}`
  const payload = JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'boxlite-clickhouse-readiness' } }],
      },
      scopeLogs: [{
        scope: { name: 'boxlite-infra' },
        logRecords: [{
          timeUnixNano: '__NOW_UNIX_NANO__',
          severityText: 'INFO',
          body: { stringValue: marker },
        }],
      }],
    }],
  })
  const escapedMarker = marker.replaceAll("'", "''")
  return `set -euo pipefail
NOW_UNIX_NANO=$(date +%s%N)
PAYLOAD=${shellLiteral(payload)}
PAYLOAD="\${PAYLOAD/__NOW_UNIX_NANO__/\${NOW_UNIX_NANO}}"
curl --silent --show-error --fail --header 'content-type: application/json' --data "$PAYLOAD" ${shellLiteral(`${collectorEndpoint.replace(/\/+$/, '')}/v1/logs`)} >/dev/null
READER_PASSWORD=$(aws secretsmanager get-secret-value --region ${shellLiteral(region)} --secret-id ${shellLiteral(readerSecretArn)} --query SecretString --output text)
for attempt in $(seq 1 60); do
  COUNT=$(CLICKHOUSE_PASSWORD="$READER_PASSWORD" docker exec -e CLICKHOUSE_PASSWORD boxlite-clickhouse clickhouse-client --user otel_reader --query ${shellLiteral(`SELECT count() FROM otel.otel_logs WHERE Body = '${escapedMarker}'`)})
  [ "$COUNT" -ge 1 ] && break
  sleep 2
done
unset READER_PASSWORD
[ "$COUNT" -ge 1 ] || { echo 'FATAL: synthetic OTLP log did not reach ClickHouse' >&2; exit 1; }`
}

function reconcile() {
  const { AWS_REGION, CLICKHOUSE_INSTANCE_ID, CLICKHOUSE_ADMIN_SECRET_ARN, CLICKHOUSE_WRITER_SECRET_ARN, CLICKHOUSE_READER_SECRET_ARN, CLICKHOUSE_EXPECTED_IMAGE, CLICKHOUSE_SCHEMA_BASE64, CLICKHOUSE_RETENTION_HOURS } = process.env
  if (!AWS_REGION || !CLICKHOUSE_INSTANCE_ID || !CLICKHOUSE_ADMIN_SECRET_ARN || !CLICKHOUSE_WRITER_SECRET_ARN || !CLICKHOUSE_READER_SECRET_ARN || !CLICKHOUSE_EXPECTED_IMAGE || !CLICKHOUSE_SCHEMA_BASE64 || !CLICKHOUSE_RETENTION_HOURS) {
    throw new Error(
      'AWS_REGION, CLICKHOUSE_INSTANCE_ID, CLICKHOUSE_ADMIN_SECRET_ARN, and CLICKHOUSE_EXPECTED_IMAGE are required',
    )
  }
  const command = buildSelfHostedReadinessCommand({
    region: AWS_REGION,
    adminSecretArn: CLICKHOUSE_ADMIN_SECRET_ARN,
    writerSecretArn: CLICKHOUSE_WRITER_SECRET_ARN,
    readerSecretArn: CLICKHOUSE_READER_SECRET_ARN,
    expectedImage: CLICKHOUSE_EXPECTED_IMAGE,
    schemaBase64: CLICKHOUSE_SCHEMA_BASE64,
    retentionHours: Number(CLICKHOUSE_RETENTION_HOURS),
  })
  runSsmCommand({
    region: AWS_REGION,
    instanceId: CLICKHOUSE_INSTANCE_ID,
    command,
    comment: 'BoxLite ClickHouse readiness',
  })
  console.log(`clickhouse-ops: ${CLICKHOUSE_INSTANCE_ID} is reconciled`)
}

function smoke() {
  const { AWS_REGION, CLICKHOUSE_INSTANCE_ID, CLICKHOUSE_READER_SECRET_ARN, OTEL_COLLECTOR_ENDPOINT } =
    process.env
  const command = buildWriterSmokeCommand({
    region: AWS_REGION,
    collectorEndpoint: OTEL_COLLECTOR_ENDPOINT,
    readerSecretArn: CLICKHOUSE_READER_SECRET_ARN,
  })
  runSsmCommand({
    region: AWS_REGION,
    instanceId: CLICKHOUSE_INSTANCE_ID,
    command,
    comment: 'BoxLite ClickHouse writer readiness',
  })
  console.log('clickhouse-ops: synthetic OTLP log arrived')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2]
  if (operation === 'reconcile') reconcile()
  else if (operation === 'smoke') smoke()
  else throw new Error('clickhouse-ops requires reconcile or smoke')
}
