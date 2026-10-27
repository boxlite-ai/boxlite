import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clickHouseStartupScript, gcpClickHouseProvider } from '../mdeploy/stack/providers/gcp/clickhouse.ts'
import { awsClickHouseProvider } from '../mdeploy/stack/providers/aws/clickhouse.ts'
import { CLICKHOUSE_IMAGE, renderClickHouseLogReaderSql } from '../mdeploy/stack/clickhouse-host.ts'
import { buildSelfHostedReadinessCommand } from './clickhouse-ops.mjs'

const input = {
  database: 'otel', writerUsername: 'otel_writer', readerUsername: 'otel_reader',
  adminRef: 'admin', writerRef: 'writer', readerRef: 'reader',
}

test('GCP provisions the dedicated reader only with its own secret reference', () => {
  const script = clickHouseStartupScript({
    ...input, openapiReaderRef: 'projects/example/secrets/log-reader/versions/1',
  })
  assert.match(script, /CREATE USER IF NOT EXISTS "otel_openapi_reader"/)
  assert.match(script, /REVOKE ALL FROM "otel_openapi_reader"/)
  assert.match(script, /GRANT SELECT, SHOW COLUMNS ON otel\.otel_logs TO "otel_openapi_reader"/)
  assert.equal((script.match(/ CONST/g) ?? []).length, 18)
  assert.doesNotMatch(script, /OR REPLACE otel_openapi_reader|clickhouse-client[^\n]*--password/)
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0)
  assert.doesNotMatch(clickHouseStartupScript(input), /otel_openapi_reader/)
})

test('the supplied policy retains every grant and immutable constraint', () => {
  const policy = readFileSync(new URL('../clickhouse/openapi-log-reader.sql', import.meta.url), 'utf8').replace(/^--.*\n/gm, '')
  assert.equal(createHash('sha256').update(policy).digest('hex'), 'c69d7dacbe342a3c3038fb53773a2063d2c540184647f8c547f772e27f802068')
  assert.ok(renderClickHouseLogReaderSql().endsWith(policy.replaceAll('__LOG_READER__', '"otel_openapi_reader"').replaceAll('__LOG_READER_PROFILE__', '"otel_openapi_reader_limits"')))
})

test('AWS readiness applies the same policy using a separate secret after schema creation', () => {
  const command = buildSelfHostedReadinessCommand({ region: 'us-east-1', adminSecretArn: 'admin',
    writerSecretArn: 'writer', readerSecretArn: 'reader', expectedImage: CLICKHOUSE_IMAGE,
    schemaBase64: 'c2NoZW1h', retentionHours: 720,
    logReaderSecretArn: 'dedicated-secret', logReaderSqlBase64: Buffer.from(renderClickHouseLogReaderSql()).toString('base64'),
  })
  assert.match(command, /--secret-id 'dedicated-secret'/)
  assert.ok(command.indexOf('LOG_READER_PASSWORD=') > command.indexOf('--multiquery < /opt/boxlite-clickhouse/schema.sql'))
  assert.match(command, /test -n "\$LOG_READER_PASSWORD"/)
  assert.doesNotMatch(command, /--password/)
  assert.equal(spawnSync('bash', ['-n'], { input: command }).status, 0)
})

test('providers reject unsupported modes and account reuse before creating resources', () => {
  for (const factory of [gcpClickHouseProvider, awsClickHouseProvider]) {
    for (const mode of ['managed', 'disabled']) {
      assert.throws(() => factory({ otelOpenapiEnabled: true })({ mode, database: 'otel' }), /requires self-hosted otel/)
    }
    for (const request of [{ database: 'other' }, { database: 'otel', readerUsername: 'otel_openapi_reader' },
      { database: 'otel', writerUsername: 'otel_openapi_reader' }]) {
      assert.throws(() => factory({ otelOpenapiEnabled: true })({ mode: 'self-hosted', ...request }), /requires self-hosted otel/)
    }
  }
})

test('real ClickHouse preserves credentials and restrictions across reconciliation and restart', {
  skip: process.env.BOXLITE_CLICKHOUSE_INTEGRATION !== '1', timeout: 240_000,
}, async () => {
  const container = `boxlite-log-reader-${process.pid}`
  const env = { ...process.env, CLICKHOUSE_PASSWORD: 'synthetic-admin-only', LOG_READER_TEST_PASSWORD: 'synthetic-reader-only' }
  const docker = (args, input) => spawnSync('docker', args, { env, input, encoding: 'utf8', timeout: 120_000 })
  const run = (args, input) => {
    const result = docker(args, input)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const query = (sql, user = 'default', password = env.CLICKHOUSE_PASSWORD) => spawnSync('docker', [
    'exec', '-i', '-e', 'CLICKHOUSE_PASSWORD', container, 'clickhouse-client', '--user', user, '--multiquery',
  ], { env: { ...env, CLICKHOUSE_PASSWORD: password }, input: sql, encoding: 'utf8', timeout: 15_000 })
  const ready = async () => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (query('SELECT 1').status === 0) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.fail('ClickHouse did not become ready')
  }
  const script = clickHouseStartupScript({ ...input, openapiReaderRef: 'projects/example/secrets/reader/versions/1' })
  const account = script.slice(script.indexOf('# Reconcile the dedicated reader'))
  const hash = script.match(/^hash_of\(\).*$/m)[0]
  const reconcile = (read = 'printf %s "$LOG_READER_TEST_PASSWORD"') => docker([
    'exec', '-i', '-e', 'CLICKHOUSE_PASSWORD', '-e', 'LOG_READER_TEST_PASSWORD', container, 'bash', '-s',
  ], `set -euo pipefail\nread_secret() { ${read}; }\n${hash}\n${account}`)
  const check = () => {
    const reader = sql => query(sql, 'otel_openapi_reader', env.LOG_READER_TEST_PASSWORD)
    assert.equal(reader('SELECT Body FROM otel.otel_logs').stdout.trim(), 'persisted')
    assert.equal(reader('DESCRIBE TABLE otel.otel_logs').status, 0)
    const policy = renderClickHouseLogReaderSql()
    for (const [, name, value] of policy.matchAll(/(\w+) = ('throw'|\d+) CONST/g)) {
      const actual = reader(`SELECT value, readonly FROM system.settings WHERE name='${name}' FORMAT JSONEachRow`)
      assert.equal(actual.status, 0, actual.stderr)
      assert.deepEqual(JSON.parse(actual.stdout), { value: value.replaceAll("'", ''), readonly: 1 }, name)
      const changed = value === "'throw'" ? "'break'" : value === '0' ? '1' : '0'
      const denied = reader(`SELECT 1 SETTINGS ${name}=${changed}`)
      assert.notEqual(denied.status, 0, name)
      assert.match(denied.stderr, /READONLY|SETTING_CONSTRAINT_VIOLATION|QUERY_IS_PROHIBITED/, name)
    }
    for (const sql of ["INSERT INTO otel.otel_logs VALUES ('denied')", 'SELECT * FROM otel.private_logs',
      'DROP TABLE otel.otel_logs']) {
      const denied = reader(sql)
      assert.notEqual(denied.status, 0, sql)
      assert.match(denied.stderr, /ACCESS_DENIED|READONLY|QUERY_IS_PROHIBITED/)
    }
    assert.match(query('SELECT 1', 'otel_openapi_reader', 'wrong').stderr, /AUTHENTICATION_FAILED/)
    assert.equal(query("SELECT count() FROM system.role_grants WHERE user_name='otel_openapi_reader'").stdout.trim(), '0')
    assert.equal(query("SELECT count() FROM system.settings_profile_elements WHERE profile_name='otel_openapi_reader_limits' AND writability='CONST'").stdout.trim(), '18')
  }
  try {
    run(['run', '-d', '--name', container, '-e', 'CLICKHOUSE_PASSWORD', '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
      process.env.BOXLITE_CLICKHOUSE_TEST_IMAGE || CLICKHOUSE_IMAGE])
    await ready()
    const setup = query(`CREATE DATABASE otel;
CREATE TABLE otel.otel_logs (Body String) ENGINE=MergeTree ORDER BY tuple();
CREATE TABLE otel.private_logs (Body String) ENGINE=Memory;
INSERT INTO otel.otel_logs VALUES ('persisted');
CREATE USER otel_openapi_reader IDENTIFIED BY '${env.LOG_READER_TEST_PASSWORD}';
CREATE ROLE excessive;
GRANT SELECT, INSERT ON otel.private_logs TO excessive;
GRANT excessive TO otel_openapi_reader;
GRANT SELECT ON otel.* TO otel_openapi_reader;`)
    assert.equal(setup.status, 0, setup.stderr)
    const identity = query("SELECT id FROM system.users WHERE name='otel_openapi_reader'").stdout
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        const drift = query(`ALTER SETTINGS PROFILE otel_openapi_reader_limits SETTINGS readonly=0, max_threads=16;
ALTER USER otel_openapi_reader SETTINGS readonly=0, max_threads=32;
GRANT excessive TO otel_openapi_reader;
GRANT SELECT ON otel.* TO otel_openapi_reader;`)
        assert.equal(drift.status, 0, drift.stderr)
      }
      const result = reconcile()
      assert.equal(result.status, 0, result.stderr)
      check()
    }
    assert.equal(query("SELECT id FROM system.users WHERE name='otel_openapi_reader'").stdout, identity)
    assert.equal(reconcile('return 42').status, 42)
    assert.equal(reconcile('return 0').status, 1)
    run(['restart', container])
    await ready()
    check()
    assert.equal(query('DROP USER otel_openapi_reader').status, 0)
    const recreated = reconcile()
    assert.equal(recreated.status, 0, recreated.stderr)
    check()
  } finally {
    docker(['rm', '-f', container])
  }
})
