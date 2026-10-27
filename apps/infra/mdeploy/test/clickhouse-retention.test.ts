import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clickHouseRetentionPolicy, clickHouseStartupScript, gcpClickHouseProvider } from '../stack/providers/gcp/clickhouse.ts'
import { awsClickHouseProvider } from '../stack/providers/aws/clickhouse.ts'

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

test('ClickHouse providers preserve host inputs and reconcile optional reader credentials', async (t) => {
  // Capture the actual provider boundary without contacting GCP. Outputs resolve synchronously.
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  const resources = new Map<string, { args: any; options: any }>()
  let rotated = ''
  let arnSuffix = ''
  let recreated = 1
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options })
      Object.assign(this, args, {
        id: output(name), arn: output(`${name}-arn${arnSuffix}`), selfLink: output(name), email: output('host@example.test'),
        instanceId: output(`${name}#${recreated}`), // A recreated VM keeps its name and self link, not its id.
        name: output(`${name}/versions/${name === rotated ? 2 : 1}`),
        networkInterfaces: [{ networkIp: '10.0.0.2' }], result: output('test-password'),
      })
    }
  }
  const lookups: Record<string, any> = {
    getSubnetOutput: () => ({ availabilityZone: 'us-east-1a' }),
    getAmiOutput: () => ({ id: output('ami') }),
    getSecretVersionsOutput: () => ({ versions: output([{ versionId: 'current', versionStages: ['AWSCURRENT'] }]) }),
  }
  const constructors = new Proxy({}, { get: (_, name) => lookups[String(name)] ?? Resource })
  const globals = {
    gcp: new Proxy({}, { get: () => constructors }), random: constructors,
    aws: new Proxy({}, { get: () => constructors }), command: { local: constructors }, $cli: { paths: { root: '/test' } },
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
  const providerConfig = {
    network: { cloud: 'gcp', network: 'network', subnetwork: 'subnet' } as any,
    project: 'project', region: 'us-central1', zone: 'us-central1-a', appShort: 'bl',
    callerRanges: ['10.0.0.0/24'], clickStackConsumerProject: 'project',
    clickStackConsumerAccount: null, managed: null, dependsOn: [],
  }
  const deploy = (retentionHours: number, otelOpenapiEnabled = false) => {
    resources.clear()
    gcpClickHouseProvider({ ...providerConfig, otelOpenapiEnabled })({ mode: 'self-hosted', database: 'otel', writerUsername: 'otel_writer',
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
  await t.test('GCP uses a separate managed secret and its version at boot', () => {
    const enabled = deploy(720, true)
    assert.equal(resources.get('ClickHouseOpenapiReaderSecret')!.args.secretId, 'boxlite-dev-clickhouse-openapi-reader')
    assert.ok(resources.has('ClickHouseOpenapiReaderSecretPassword'))
    assert.match(enabled.script, /read_secret 'ClickHouseOpenapiReaderSecretValue\/versions\/1'/)
    assert.match(enabled.script, /CREATE USER IF NOT EXISTS "otel_openapi_reader"/)
    assert.equal(resources.get('ClickHouseSecretAccess3')!.args.role, 'roles/secretmanager.secretAccessor')
    assert.ok(resources.get('ClickHouse')!.options.dependsOn.some((resource: any) => resource.secretId === 'boxlite-dev-clickhouse-openapi-reader'))
    assert.equal(deploy(720, true).script, enabled.script)
    rotated = 'ClickHouseOpenapiReaderSecretValue'
    assert.notEqual(deploy(720, true).script, enabled.script)
    rotated = ''
    assert.equal(deploy(720).script, after.script)
    assert.ok(!resources.has('ClickHouseOpenapiReaderSecret'))
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
  await t.test('a VM recreated under its own name rejoins the published group', (subtest) => {
    const declared = (id: number) => { recreated = id; deploy(720); recreated = 1; return new Map([...resources].map(([name, { args }]) => [name, JSON.stringify(args)])) }
    const before = declared(1)
    const changed = [...declared(2)].filter(([name, args]) => before.get(name) !== args).map(([name]) => name)
    assert.deepEqual(changed, ['ClickStackMembership'], 'nothing re-adds the recreated VM, so its group stays empty')
    const { create, environment } = resources.get('ClickStackMembership')!.args
    const env = Object.fromEntries(Object.entries(environment).map(([key, value]: [string, any]) => [key, value.value ?? value]))
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-membership-')), members = join(directory, 'members')
    subtest.after(() => rmSync(directory, { recursive: true, force: true }))
    // Compute Engine as the script meets it: names listed, an existing member refused, anything else unexpected.
    writeFileSync(join(directory, 'gcloud'), `#!/bin/sh
[ "$5 $6 $7" = "$GROUP --project=$PROJECT --zone=$ZONE" ] || exit 2
case "$4 $8" in
  "list-instances --format=value(instance.basename())") cat "$MEMBERS" ;;
  "add-instances --instances=$INSTANCE") ! grep -qx "$INSTANCE" "$MEMBERS" || exit 1; echo "$INSTANCE" >> "$MEMBERS" ;;
  *) exit 2 ;; esac
`, { mode: 0o700 })
    const run = (current?: string) => {
      if (current === undefined) rmSync(members, { force: true }); else writeFileSync(members, current)
      return spawnSync('sh', ['-c', create], { env: { ...process.env, ...env, MEMBERS: members, PATH: `${directory}:${process.env.PATH}` } }).status
    }
    assert.deepEqual([run(''), readFileSync(members, 'utf8')], [0, `${env.INSTANCE}\n`], 'the recreated VM joins its emptied group')
    assert.equal(run(`${env.INSTANCE}\n`), 0, 'a VM still in its group is left alone')
    assert.notEqual(run(), 0, 'a group that cannot be read fails the deploy')
  })
  await t.test('AWS uses unique secret names and propagates the returned ARN through IAM and readiness', () => {
    const invoke = (otelOpenapiEnabled: boolean) => {
      resources.clear()
      return awsClickHouseProvider({
        region: 'us-east-1', managed: null, otelOpenapiEnabled,
        network: { cloud: 'aws', vpcId: 'vpc', vpc: { securityGroups: [] }, privateSubnets: ['subnet'] } as any,
      })({ mode: 'self-hosted', database: 'otel', writerUsername: 'otel_writer', readerUsername: 'otel_reader',
        instanceSize: 'small', dataGb: 100, retentionHours: 720 })
    }
    invoke(true)
    const readiness = resources.get('ClickHouseDatabaseReady')!.args
    assert.equal(resources.get('ClickHouseOpenapiReaderSecret')!.args.namePrefix, 'boxlite-dev-clickhouse-openapi-reader-')
    assert.equal(resources.get('ClickHouseOpenapiReaderSecret')!.args.name, undefined)
    assert.equal(resources.get('ClickHouseOpenapiReaderSecret')!.args.recoveryWindowInDays, 7)
    assert.equal(resources.get('ClickHouseReaderSecret')!.args.namePrefix, 'boxlite-dev-clickhouse-reader-')
    assert.equal(readiness.environment.CLICKHOUSE_OPENAPI_READER_SECRET_ARN.value, 'ClickHouseOpenapiReaderSecret-arn')
    const sql = Buffer.from(readiness.environment.CLICKHOUSE_OPENAPI_READER_SQL_BASE64, 'base64').toString()
    assert.match(sql, /REVOKE ALL FROM "otel_openapi_reader"/)
    assert.ok(readiness.triggers.includes(sql))
    assert.ok(readiness.triggers.some((value: any) => value?.value === 'ClickHouseOpenapiReaderSecretValue'))
    assert.ok(JSON.parse(resources.get('ClickHouseSecretPolicy')!.args.policy.value).Statement[0].Resource.includes('ClickHouseOpenapiReaderSecret-arn'))
    invoke(false)
    assert.ok(!resources.has('ClickHouseOpenapiReaderSecret'))
    assert.equal(resources.get('ClickHouseDatabaseReady')!.args.environment.CLICKHOUSE_OPENAPI_READER_SECRET_ARN, undefined)
    arnSuffix = '-replacement'
    invoke(true)
    assert.equal(resources.get('ClickHouseDatabaseReady')!.args.environment.CLICKHOUSE_OPENAPI_READER_SECRET_ARN.value,
      'ClickHouseOpenapiReaderSecret-arn-replacement')
    const allowed = JSON.parse(resources.get('ClickHouseSecretPolicy')!.args.policy.value).Statement[0].Resource
    assert.ok(allowed.includes('ClickHouseOpenapiReaderSecret-arn-replacement'))
    assert.ok(!allowed.includes('ClickHouseOpenapiReaderSecret-arn'))
  })
})
