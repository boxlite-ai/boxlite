// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import * as readiness from './clickhouse-readiness.mjs'

const { buildSelfHostedReadinessCommand, isTransientSsmError } = readiness

test('readiness command validates image, service, and every telemetry table without a password value', () => {
  const command = buildSelfHostedReadinessCommand({
    region: 'ap-southeast-1',
    adminSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:admin',
    writerSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:writer',
    readerSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:reader',
    expectedImage: 'clickhouse/clickhouse-server@sha256:abc',
    schemaBase64: Buffer.from('CREATE DATABASE IF NOT EXISTS otel').toString('base64'),
    retentionHours: 72,
  })
  assert.match(command, /if ! cloud-init status --wait; then/)
  assert.match(command, /tail -n 200 \/var\/log\/clickhouse-setup\.log >&2/)
  assert.match(command, /exit 1/)
  assert.match(command, /systemctl restart boxlite-clickhouse/)
  assert.match(command, /systemctl is-active --quiet boxlite-clickhouse/)
  assert.match(command, /boxlite-clickhouse-sql-users/)
  assert.match(command, /mountpoint -q \/var\/lib\/boxlite-clickhouse/)
  assert.match(command, /sha256:abc/)
  assert.match(command, /secretsmanager get-secret-value/)
  for (const table of ['otel_logs', 'otel_traces', 'otel_metrics_gauge', 'otel_metrics_sum', 'otel_metrics_summary', 'otel_metrics_histogram', 'otel_metrics_exponential_histogram']) {
    assert.match(command, new RegExp(`DESCRIBE TABLE otel.${table}`))
  }
  assert.match(command, /SHOW GRANTS FOR otel_writer/)
  assert.match(command, /INTERVAL 72 HOUR/)
  assert.match(command, /position\(create_table_query, 'toIntervalHour\(72\)'\)/)
  assert.doesNotMatch(command, /position\(create_table_query, 'INTERVAL 72 HOUR'\)/)
  assert.match(command, /--user otel_reader/)
  assert.doesNotMatch(command, /clickhouse-client[^\n]*--password(?:\s|$)/)
  assert.doesNotMatch(command, /SecretString.*[=:][^$\n]+/)
})

test('retries only eventual-consistency and throttling failures from SSM', () => {
  assert.equal(isTransientSsmError(new Error('TargetNotConnected')), true)
  assert.equal(isTransientSsmError(new Error('InvocationDoesNotExist')), true)
  assert.equal(isTransientSsmError(new Error('AccessDeniedException')), false)
})

test('runs every SSM shell payload through an explicit Bash boundary', () => {
  const source = readFileSync(new URL('./clickhouse-readiness.mjs', import.meta.url), 'utf8')
  assert.match(source, /commands: \[buildSsmBashCommand\(command\)\]/)

  assert.equal(typeof readiness.buildSsmBashCommand, 'function')
  const wrapped = readiness.buildSsmBashCommand(`set -euo pipefail\nprintf %s "it's ready"`)
  const result = spawnSync('/bin/sh', ['-c', wrapped], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "it's ready")
})
