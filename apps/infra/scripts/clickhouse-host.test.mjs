// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  buildClickHouseUserData,
  CLICKHOUSE_IMAGE,
  EC2_USER_DATA_MAX_BYTES,
  encodeClickHouseUserData,
  renderClickHouseSchema,
} from './clickhouse-host.ts'

const input = {
  region: 'ap-southeast-1',
  volumeId: 'vol-0123456789abcdef0',
  adminSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:admin',
  writerSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:writer',
  readerSecretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:reader',
}

test('builds syntactically valid, secret-free, idempotent bootstrap shell', () => {
  const script = buildClickHouseUserData(input)
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-clickhouse-bootstrap-'))
  const path = join(directory, 'bootstrap.sh')
  writeFileSync(path, script)
  execFileSync('bash', ['-n', path])

  assert.match(script, /blkid .*mkfs\.ext4/s)
  assert.match(script, /mountpoint -q/)
  assert.match(script, /aws secretsmanager get-secret-value/)
  assert.match(script, /CLICKHOUSE_IMAGE=.*sha256:/)
  assert.match(script, /RequiresMountsFor=\/var\/lib\/boxlite-clickhouse/)
  assert.doesNotMatch(script, /defaults,nofail/)
  assert.match(script, /CREATE USER IF NOT EXISTS otel_writer IDENTIFIED WITH sha256_hash/)
  assert.match(script, /ALTER USER otel_reader IDENTIFIED WITH sha256_hash/)
  assert.doesNotMatch(script, /<otel_writer>/)
  assert.match(script, /<default replace="replace"><password_sha256_hex>\$ADMIN_HASH/)
  assert.match(script, /<networks><ip>127\.0\.0\.1<\/ip><ip>::1<\/ip>/)
  assert.match(script, /chown 101:101 \/run\/boxlite-clickhouse-users\.xml/)
  assert.match(script, /chmod 0400 \/run\/boxlite-clickhouse-users\.xml/)
  assert.doesNotMatch(script, /clickhouse-client[^\n]*--password(?:\s|$)/)
  assert.doesNotMatch(script, /docker exec[^\n]*-e CLICKHOUSE_PASSWORD=/)
  assert.doesNotMatch(script, /CLICKHOUSE_PASSWORD=['"](?!\$)/)
  assert.doesNotMatch(script, /password_sha256_hex>[0-9a-f]{64}/)
  assert.equal(CLICKHOUSE_IMAGE.includes('@sha256:'), true)
})

test('installs AWS CLI v2 without relying on Ubuntu awscli packaging', () => {
  const script = buildClickHouseUserData(input)
  const firstSecretRead = script.indexOf('aws secretsmanager get-secret-value')
  const awsCliInstall = script.indexOf('"$AWS_CLI_TMP/aws/install" --bin-dir /usr/local/bin')

  assert.doesNotMatch(script, /apt-get install[^\n]*\bawscli\b/)
  assert.match(script, /apt-get install -y docker\.io curl unzip/)
  assert.match(
    script,
    /curl --fail --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 300/,
  )
  assert.match(script, /https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-x86_64\.zip/)
  assert.doesNotMatch(script, /if ! command -v aws/)
  assert.match(script, /\/usr\/local\/bin\/aws --version 2>&1 \| grep -q '\^aws-cli\/2\\\.'/)
  assert.ok(awsCliInstall >= 0 && awsCliInstall < firstSecretRead, 'AWS CLI must be installed before secrets are read')
})

test('does not write an unused runtime environment file', () => {
  assert.doesNotMatch(
    buildClickHouseUserData(input),
    /\/run\/boxlite-clickhouse\.env/,
    'bootstrap must not create an unused environment file',
  )
})

test('leaves schema reconciliation to the post-boot readiness barrier', () => {
  const script = buildClickHouseUserData(input)

  assert.doesNotMatch(script, /\/opt\/boxlite-clickhouse\/schema\.sql/)
  assert.doesNotMatch(script, /^\/usr\/local\/bin\/boxlite-clickhouse-sql-users$/m)
  assert.doesNotMatch(script, /^GRANT /m)
  assert.ok(Buffer.byteLength(script) <= EC2_USER_DATA_MAX_BYTES)
})

test('vendors every v0.144 telemetry table', () => {
  const schema = renderClickHouseSchema()
  assert.match(schema, /INTERVAL 72 HOUR/)
  for (const table of [
    'otel_logs',
    'otel_traces',
    'otel_metrics_gauge',
    'otel_metrics_sum',
    'otel_metrics_summary',
    'otel_metrics_histogram',
    'otel_metrics_exponential_histogram',
  ]) {
    assert.match(schema, new RegExp(table))
  }
})

test('encodes deterministic user data within the EC2 limit', () => {
  const script = buildClickHouseUserData(input)
  const encoded = encodeClickHouseUserData(input)
  const decoded = Buffer.from(encoded, 'base64')

  assert.ok(decoded.byteLength <= EC2_USER_DATA_MAX_BYTES)
  assert.equal(decoded.toString(), script)
  assert.equal(encodeClickHouseUserData(input), encoded)
})

test('rejects user data over the EC2 decoded-byte limit', () => {
  const oversizedVolumeId = Array.from({ length: 2_048 }, (_, index) =>
    createHash('sha256').update(String(index)).digest('hex')
  ).join('')

  assert.throws(
    () => encodeClickHouseUserData({ ...input, volumeId: oversizedVolumeId }),
    /ClickHouse user data is \d+ bytes; EC2 allows 16384/,
  )
})

test('loads the schema after SST relocates the module under .sst/platform', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-clickhouse-sst-bundle-'))
  const platformDirectory = join(directory, '.sst', 'platform')
  const bundledModule = join(platformDirectory, 'clickhouse-host.ts')
  mkdirSync(platformDirectory, { recursive: true })
  copyFileSync(new URL('./clickhouse-host.ts', import.meta.url), bundledModule)

  const relocated = await import(pathToFileURL(bundledModule).href)

  assert.match(relocated.renderClickHouseSchema(), /INTERVAL 72 HOUR/)
})
