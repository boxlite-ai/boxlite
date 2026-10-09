import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clickHouseRetentionPolicy, clickHouseStartupScript, gcpClickHouseProvider } from '../stack/providers/gcp/clickhouse.ts'

test('GCP bootstrap uses 30 days while the policy uses configured hours', () => {
  const script = clickHouseStartupScript({
    database: 'otel', writerUsername: 'otel_writer', readerUsername: 'otel_reader',
    adminRef: 'admin', writerRef: 'writer', readerRef: 'reader',
  })
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)![1]
  assert.equal((Buffer.from(encoded, 'base64').toString().match(/INTERVAL 720 HOUR/g) ?? []).length, 7)
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
    const query = readFileSync(environment.QUERY_FILE, 'utf8')
    // The same marker the AWS readiness check matches: ClickHouse's own
    // spelling of the interval, not of the whole TTL expression.
    assert.match(query, /position\(create_table_query, 'toIntervalHour\(168\)'\) > 0/)
    assert.doesNotMatch(query, /toDateTime\(/)
    for (const table of ['otel_logs', 'otel_traces', 'otel_metrics_gauge']) assert.match(query, new RegExp(`'${table}'`))
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

test('GCP retention changes preserve VM inputs while secret rotations reach the startup script', async (t) => {
  // Capture the actual provider boundary without contacting GCP. Outputs resolve synchronously.
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  const resources = new Map<string, { args: any; options: any }>()
  let rotated = ''
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options })
      Object.assign(this, args, {
        id: output(name), selfLink: output(name), email: output('host@example.test'),
        name: output(`${name}/versions/${name === rotated ? 2 : 1}`),
        networkInterfaces: [{ networkIp: '10.0.0.2' }], result: output('test-password'),
      })
    }
  }
  const constructors = new Proxy({}, { get: () => Resource })
  const globals = {
    gcp: new Proxy({}, { get: () => constructors }), random: constructors,
    $app: { name: 'boxlite', stage: 'dev' },
    $util: { output, secret: output },
    $resolve: (values: any[]) => output(values.map((value) => value.value)),
    $interpolate: () => output('http://10.0.0.2:8123'),
  }
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  const provider = gcpClickHouseProvider({
    network: { cloud: 'gcp', network: 'network', subnetwork: 'subnet' } as any,
    project: 'project', region: 'us-central1', zone: 'us-central1-a', appShort: 'bl',
    callerRanges: ['10.0.0.0/24'], clickStackConsumerProject: 'project',
    clickStackConsumerAccount: null, managed: null, dependsOn: [],
  })
  const deploy = (retentionHours: number) => {
    provider({ mode: 'self-hosted', database: 'otel', writerUsername: 'otel_writer',
      readerUsername: 'otel_reader', instanceSize: 'small', dataGb: 100, retentionHours })
    const vm = resources.get('ClickHouse')!
    const policy = resources.get('ClickHouseRetention')!.args.osPolicies[0].resourceGroups[0].resources[0].exec
    return { script: vm.args.metadataStartupScript.value, ignored: vm.options.ignoreChanges,
      policy: policy.enforce.script.value }
  }
  const before = deploy(72)
  const after = deploy(720)
  await t.test('TTL updates change only the policy', () => {
    assert.ok(after.script === before.script, 'TTL changes must not change the VM startup script')
    assert.notEqual(after.policy, before.policy)
    assert.match(after.policy, /INTERVAL 720 HOUR/)
  })
  for (const account of ['Admin', 'Writer', 'Reader']) {
    rotated = `ClickHouse${account}SecretValue`
    const rotation = deploy(720)
    await t.test(`${account} rotation updates the VM`, () => {
      assert.notEqual(rotation.script, after.script, `${account} rotation must reach the VM`)
      assert.ok(!rotation.ignored.includes('metadataStartupScript'), 'credential updates must not be ignored')
      assert.match(rotation.script, new RegExp(`${rotated}/versions/2`))
    })
  }
})
