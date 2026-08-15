// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWriterSmokeCommand } from './clickhouse-writer-ready.mjs'

test('writer smoke posts an OTLP log and polls the real exported table', () => {
  const command = buildWriterSmokeCommand({
    region: 'ap-southeast-1',
    collectorEndpoint: 'http://collector.internal:4318/',
    adminSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:admin',
  })
  assert.match(command, /http:\/\/collector\.internal:4318\/v1\/logs/)
  assert.match(command, /boxlite-clickhouse-readiness/)
  assert.match(command, /FROM otel\.otel_logs WHERE Body/)
  assert.match(command, /secretsmanager get-secret-value/)
  assert.doesNotMatch(command, /clickhouse-client[^\n]*--password(?:\s|$)/)
  assert.doesNotMatch(command, /password_sha256_hex/)
})

test('writer smoke uses fresh evidence for every rollout probe', () => {
  const input = {
    region: 'ap-southeast-1',
    collectorEndpoint: 'http://collector.internal:4318/',
    adminSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:admin',
  }

  const first = buildWriterSmokeCommand(input)
  const second = buildWriterSmokeCommand(input)

  assert.notEqual(first, second, 'a later rollout must not match a marker retained from an earlier rollout')
  assert.match(first, /boxlite-clickhouse-smoke-[0-9a-f-]{36}/)
  assert.match(second, /boxlite-clickhouse-smoke-[0-9a-f-]{36}/)
})
