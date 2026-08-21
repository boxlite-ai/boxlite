// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import * as clickHouseConfig from './clickhouse.js'

const { CLICKHOUSE_STAGE_CONFIG_KEYS, resolveClickHouseConfig } = clickHouseConfig

test('defaults to one active self-hosted backend', () => {
  assert.deepEqual(resolveClickHouseConfig({}), {
    mode: 'self-hosted',
    active: true,
  })
})

test('exposes only the backend selector and managed connection', () => {
  assert.deepEqual(CLICKHOUSE_STAGE_CONFIG_KEYS, [
    'CLICKHOUSE_MODE',
    'CLICKHOUSE_URL',
    'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
    'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
  ])
})

test('disables ClickHouse without provisioning a backend', () => {
  assert.deepEqual(resolveClickHouseConfig({ CLICKHOUSE_MODE: 'disabled' }), {
    mode: 'disabled',
    active: false,
  })
})

test('connects one managed endpoint with separate writer and reader principals', () => {
  assert.deepEqual(
    resolveClickHouseConfig({
      CLICKHOUSE_MODE: 'managed',
      CLICKHOUSE_URL: 'https://example.clickhouse.cloud:8443',
      CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:writer',
      CLICKHOUSE_READER_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:reader',
    }),
    {
      mode: 'managed',
      active: true,
      url: 'https://example.clickhouse.cloud:8443',
      writerSecretArn: 'arn:aws:secretsmanager:region:account:secret:writer',
      readerSecretArn: 'arn:aws:secretsmanager:region:account:secret:reader',
    },
  )
})

test('requires the complete managed connection', () => {
  assert.throws(() => resolveClickHouseConfig({ CLICKHOUSE_MODE: 'managed' }), /CLICKHOUSE_URL is required/)
  assert.throws(
    () => resolveClickHouseConfig({ CLICKHOUSE_MODE: 'managed', CLICKHOUSE_URL: 'https://example' }),
    /CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN is required/,
  )
})

test('requires one HTTP endpoint shared by the collector and API', () => {
  const managed = {
    CLICKHOUSE_MODE: 'managed',
    CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:writer',
    CLICKHOUSE_READER_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:region:account:secret:reader',
  }

  assert.throws(
    () => resolveClickHouseConfig({ ...managed, CLICKHOUSE_URL: 'tcp://example.clickhouse.cloud:9000' }),
    /CLICKHOUSE_URL must use http or https/,
  )
  assert.throws(
    () => resolveClickHouseConfig({ ...managed, CLICKHOUSE_URL: 'not a URL' }),
    /CLICKHOUSE_URL must be a valid URL/,
  )
  assert.throws(
    () => resolveClickHouseConfig({ ...managed, CLICKHOUSE_URL: 'https://reader:plaintext@example.clickhouse.cloud:8443' }),
    /CLICKHOUSE_URL cannot contain credentials/,
  )
  for (const query of [
    'access_token=plaintext',
    'password=plaintext',
    'user=otel_writer',
    'username=otel_writer',
  ]) {
    assert.throws(
      () => resolveClickHouseConfig({ ...managed, CLICKHOUSE_URL: `https://example.clickhouse.cloud:8443?${query}` }),
      /CLICKHOUSE_URL cannot contain credentials/,
      query,
    )
  }
  for (const url of [
    'https://example.clickhouse.cloud:8443/otel',
    'https://example.clickhouse.cloud:8443/.',
    'https://example.clickhouse.cloud:8443/foo/..',
    'https://example.clickhouse.cloud:8443/%2e%2e',
    'https://example.clickhouse.cloud:8443?compress=false',
    'https://example.clickhouse.cloud:8443#otel',
  ]) {
    assert.throws(
      () => resolveClickHouseConfig({ ...managed, CLICKHOUSE_URL: url }),
      /CLICKHOUSE_URL must be an origin URL without a path, query, or fragment/,
      url,
    )
  }
  const normalized = resolveClickHouseConfig({
    ...managed,
    CLICKHOUSE_URL: 'https://example.clickhouse.cloud:8443/',
  })
  assert.equal(normalized.mode, 'managed')
  if (normalized.mode !== 'managed') assert.fail('managed configuration was not resolved')
  assert.equal(normalized.url, 'https://example.clickhouse.cloud:8443')
})

test('requires distinct managed writer and reader secrets', () => {
  const sharedSecretArn = 'arn:aws:secretsmanager:region:account:secret:shared'
  assert.throws(
    () =>
      resolveClickHouseConfig({
        CLICKHOUSE_MODE: 'managed',
        CLICKHOUSE_URL: 'https://example.clickhouse.cloud:8443',
        CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN: sharedSecretArn,
        CLICKHOUSE_READER_PASSWORD_SECRET_ARN: sharedSecretArn,
      }),
    /managed ClickHouse writer and reader secrets must be different/,
  )
})

test('requires managed passwords to use Secrets Manager ARNs readable by this stage', () => {
  assert.equal(
    typeof clickHouseConfig.requireClickHouseSecretArn,
    'function',
    'the managed-secret boundary validator is missing',
  )
  const scope = {
    region: 'ap-southeast-1',
    accountId: '123456789012',
    appName: 'boxlite',
    stage: 'dev',
  }
  const valid = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-clickhouse-writer-AbCdEf'
  assert.equal(clickHouseConfig.requireClickHouseSecretArn('CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN', valid, scope), valid)

  for (const arn of [
    'not-an-arn:secret:boxlite-dev-clickhouse-writer',
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:boxlite-dev-clickhouse-writer-AbCdEf',
    'arn:aws:secretsmanager:ap-southeast-1:999999999999:secret:boxlite-dev-clickhouse-writer-AbCdEf',
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:other-dev-clickhouse-writer-AbCdEf',
    `${valid}:password::`,
    `${valid}::AWSCURRENT:`,
    'arn:aws:ssm:ap-southeast-1:123456789012:parameter/boxlite-dev-clickhouse-writer',
  ]) {
    assert.throws(
      () => clickHouseConfig.requireClickHouseSecretArn('CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN', arn, scope),
      /CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN must be a same-stage Secrets Manager ARN/,
      arn,
    )
  }
})

test('rejects removed tuning, multi-phase, and plaintext-secret inputs', () => {
  for (const key of [
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
  ]) {
    assert.throws(() => resolveClickHouseConfig({ [key]: 'set' }), new RegExp(`${key} is not supported`))
  }
})

test('rejects backend-specific inputs in the wrong mode', () => {
  assert.throws(
    () => resolveClickHouseConfig({ CLICKHOUSE_MODE: 'self-hosted', CLICKHOUSE_URL: 'https://example' }),
    /CLICKHOUSE_URL cannot be set when CLICKHOUSE_MODE=self-hosted/,
  )
  assert.throws(
    () =>
      resolveClickHouseConfig({
        CLICKHOUSE_MODE: 'managed',
        CLICKHOUSE_SELF_HOSTED_DATA_GB: '50',
      }),
    /CLICKHOUSE_SELF_HOSTED_DATA_GB is not supported/,
  )
})
