import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clickHouseRetentionPolicy, clickHouseStartupScript } from '../stack/providers/gcp/clickhouse.ts'

test('GCP initial schema and policy use the configured hours', () => {
  const script = clickHouseStartupScript({
    database: 'otel', writerUsername: 'otel_writer', readerUsername: 'otel_reader',
    adminRef: 'admin', writerRef: 'writer', readerRef: 'reader', retentionHours: 168,
  })
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)![1]
  assert.equal((Buffer.from(encoded, 'base64').toString().match(/INTERVAL 168 HOUR/g) ?? []).length, 7)
  assert.notEqual(clickHouseRetentionPolicy(168, 'admin').validate, clickHouseRetentionPolicy(720, 'admin').validate)
})

test('GCP validates actual TTLs and enforces all tables, propagating SQL failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-retention-'))
  try {
    writeFileSync(join(directory, 'gcloud'), '#!/bin/bash\nif [ "${FAIL_SECRET:-}" = 1 ]; then exit 43; fi\nprintf cGFzc3dvcmQ=\n', { mode: 0o700 })
    writeFileSync(join(directory, 'clickhouse-client'), `#!/bin/bash
set -eu
if [ "\${FAIL_SQL:-}" = 1 ]; then exit 42; fi
if [ "$2" = --multiquery ]; then
  cat > "$SQL_FILE"
  printf '%s' "\${COUNT_AFTER:-7}" > "$STATE_FILE"
else
  printf '%s' "$3" > "$QUERY_FILE"
  cat "$STATE_FILE"
fi
`, { mode: 0o700 })
    const scripts = clickHouseRetentionPolicy(168, 'projects/p/secrets/admin/versions/1')
    const environment = {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, STATE_FILE: join(directory, 'state'),
      SQL_FILE: join(directory, 'sql'), QUERY_FILE: join(directory, 'query'),
    }
    const run = (script: string, extra = {}) => spawnSync('bash', ['-c', script], { env: { ...environment, ...extra }, encoding: 'utf8' })
    for (const script of Object.values(scripts)) assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0)
    writeFileSync(environment.STATE_FILE, '7')
    assert.equal(run(scripts.validate).status, 100)
    writeFileSync(environment.STATE_FILE, '6')
    assert.equal(run(scripts.validate).status, 101)
    assert.match(readFileSync(environment.QUERY_FILE, 'utf8'), /TTL toDateTime\(TimestampTime\) \+ toIntervalHour\(168\)/)
    assert.equal(run(scripts.enforce).status, 100)
    const sql = readFileSync(environment.SQL_FILE, 'utf8')
    assert.equal((sql.match(/ALTER TABLE otel\./g) ?? []).length, 7)
    assert.equal((sql.match(/INTERVAL 168 HOUR/g) ?? []).length, 7)
    assert.match(sql, /otel_logs MODIFY TTL toDateTime\(TimestampTime\)/)
    assert.match(sql, /otel_traces MODIFY TTL toDateTime\(Timestamp\)/)
    assert.match(sql, /otel_metrics_gauge MODIFY TTL toDateTime\(TimeUnix\)/)
    assert.equal(run(scripts.validate, { FAIL_SQL: '1' }).status, 42)
    assert.equal(run(scripts.enforce, { FAIL_SQL: '1' }).status, 42)
    assert.equal(run(scripts.enforce, { COUNT_AFTER: '6' }).status, 1)
    assert.equal(run(scripts.validate, { FAIL_SECRET: '1' }).status, 43)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('GCP deploy changes the retention policy without replacing the VM', () => {
  const source = readFileSync(new URL('../stack/providers/gcp/clickhouse.ts', import.meta.url), 'utf8')
  assert.match(source, /ignoreChanges: \['bootDisk', 'metadataStartupScript'\]/)
  assert.match(source, /new gcp\.osconfig\.OsPolicyAssignment\('ClickHouseRetention'/)
  assert.match(source, /clickHouseRetentionPolicy\(request\.retentionHours, ref\)/)
  assert.match(source, /metadata: \{ 'enable-osconfig': 'TRUE' \}/)
})
