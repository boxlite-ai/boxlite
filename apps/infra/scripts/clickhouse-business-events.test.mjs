import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { CLICKHOUSE_IMAGE, renderClickHouseSchema } from '../mdeploy/stack/clickhouse-host.ts'
import { clickHouseRetentionPolicy, clickHouseStartupScript } from '../mdeploy/stack/providers/gcp/clickhouse.ts'
import { buildSelfHostedReadinessCommand } from './clickhouse-ops.mjs'

const awsReadiness = () => buildSelfHostedReadinessCommand({ region: 'us-east-1', adminSecretArn: 'admin',
  writerSecretArn: 'writer', readerSecretArn: 'reader', expectedImage: CLICKHOUSE_IMAGE, schemaBase64: 'c2NoZW1h',
  retentionHours: 720 })
const gcpStartup = () => clickHouseStartupScript({ database: 'otel', writerUsername: 'otel_writer',
  readerUsername: 'otel_reader', adminRef: 'admin', writerRef: 'writer', readerRef: 'reader' })

test('the business event copy follows the telemetry tables it reads, outside their retention', () => {
  const schema = renderClickHouseSchema(168)
  assert.ok(schema.indexOf('analytics.business_events_mv') > schema.indexOf('`otel`.`otel_logs`'))
  assert.match(schema, /TTL toDateTime\(Timestamp\) \+ INTERVAL 400 DAY/)
  // Telemetry retention reconciles the seven otel tables and nothing else.
  assert.doesNotMatch(clickHouseRetentionPolicy(168, 'admin').enforce, /analytics/)
})

test('both clouds provision a writer whose inserts outlive a failing view', () => {
  assert.match(awsReadiness(), /TO otel_writer;\n.*\nALTER USER otel_writer SETTINGS materialized_views_ignore_errors = 1;/)
  assert.match(gcpStartup(), /CREATE USER OR REPLACE otel_writer IDENTIFIED WITH sha256_hash BY '\$WRITER_HASH' SETTINGS materialized_views_ignore_errors = 1"/)
})

test('real ClickHouse copies organization business events once, and a broken copy never fails telemetry', {
  skip: process.env.BOXLITE_CLICKHOUSE_INTEGRATION !== '1', timeout: 240_000,
}, async () => {
  const container = `boxlite-business-events-${process.pid}`
  const env = { ...process.env, CLICKHOUSE_PASSWORD: 'synthetic-admin-only' }
  const docker = (args, input) => spawnSync('docker', args, { env, input, encoding: 'utf8', timeout: 120_000 })
  const query = (sql) => {
    const result = docker(['exec', '-i', '-e', 'CLICKHOUSE_PASSWORD', container, 'clickhouse-client', '--multiquery'], sql)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const ready = async () => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (docker(['exec', '-e', 'CLICKHOUSE_PASSWORD', container, 'clickhouse-client', '--query', 'SELECT 1']).status === 0) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.fail('ClickHouse did not become ready')
  }
  try {
    const started = docker(['run', '-d', '--name', container, '-e', 'CLICKHOUSE_PASSWORD',
      '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1', process.env.BOXLITE_CLICKHOUSE_TEST_IMAGE || CLICKHOUSE_IMAGE])
    assert.equal(started.status, 0, started.stderr)
    await ready()
    query(renderClickHouseSchema())
    query(`INSERT INTO otel.otel_logs (Timestamp, ServiceName, Body, LogAttributes) VALUES
  ('2026-10-27 16:00:00.123456789', 'api', 'box.exec requested', map('event.name', 'box.exec', 'event.outcome', 'requested',
    'organization.id', 'org-1', 'correlation.id', 'box-1', 'actor.kind', 'user', 'user.id', 'user-1', 'auth.method', 'api_key')),
  ('2026-10-27 16:00:01', 'api', 'user.login success', map('event.name', 'user.login', 'event.outcome', 'success', 'correlation.id', 'user-1')),
  ('2026-10-27 16:00:02', 'api', 'GET /health', map('organization.id', 'org-1'))`)
    // Reapplying at the next boot or readiness run must neither fail nor copy twice.
    query(renderClickHouseSchema())

    const copied = query('SELECT * FROM analytics.business_events FORMAT JSONEachRow')
    assert.deepEqual(JSON.parse(copied), {
      Timestamp: '2026-10-27 16:00:00.123456789',
      OrganizationId: 'org-1',
      UserId: 'user-1',
      EventName: 'box.exec',
      Outcome: 'requested',
      CorrelationId: 'box-1',
      ActorKind: 'user',
      Reason: '',
      ExceptionType: '',
      AuthMethod: 'api_key',
      ClientSource: '',
      SdkVersion: '',
    })
    assert.equal(query("SELECT sorting_key FROM system.tables WHERE database = 'analytics' AND name = 'business_events'"),
      'OrganizationId, Timestamp')

    // With the copy broken, the writer each cloud provisions still lands its telemetry.
    const hash = createHash('sha256').update('synthetic-writer').digest('hex')
    const provisioning = {
      gcp: [...gcpStartup().matchAll(/--query "((?:CREATE USER OR REPLACE|GRANT) [^"]*)"/g)]
        .map(([, sql]) => sql.replaceAll('$WRITER_HASH', hash).replaceAll('$READER_HASH', hash)).join(';\n'),
      // The host bootstrap creates both accounts before readiness configures them.
      aws: `CREATE USER OR REPLACE otel_writer IDENTIFIED WITH sha256_hash BY '${hash}';
CREATE USER OR REPLACE otel_reader IDENTIFIED WITH sha256_hash BY '${hash}';
${awsReadiness().match(/<<'SQL'\n([\s\S]*?)\nSQL\n/)[1]}`,
    }
    query('RENAME TABLE analytics.business_events TO analytics.business_events_parked')
    for (const [cloud, sql] of Object.entries(provisioning)) {
      query(sql)
      const inserted = docker(['exec', '-e', 'CLICKHOUSE_PASSWORD=synthetic-writer', container, 'clickhouse-client',
        '--user', 'otel_writer', '--query', `INSERT INTO otel.otel_logs (Timestamp, Body, LogAttributes)
          VALUES (now64(9), '${cloud}', map('event.name', 'box.exec', 'organization.id', 'org-1'))`])
      assert.equal(inserted.status, 0, `${cloud}: ${inserted.stderr}`)
    }
    assert.equal(query("SELECT count() FROM otel.otel_logs WHERE Body IN ('gcp', 'aws')"), '2')
  } finally {
    docker(['rm', '-f', container])
  }
})
