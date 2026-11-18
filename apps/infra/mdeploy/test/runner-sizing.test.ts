import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { awsRunnerProvider } from '../stack/providers/aws/runners.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import type { RunnerRequest } from '../stack/runners.ts'

// Record actual provider declarations; this does not simulate Pulumi state reconciliation.
const captureResources = (t: TestContext) => {
  const resources = new Map<string, { args: any; options: any; resource: any }>()
  const unwrap = (value: any): any => value?.value ?? value
  const output = (value: any): any =>
    value?.apply ? value : { value, apply: (fn: (value: any) => any) => output(fn(value)) }
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options, resource: this })
      Object.assign(this, args, {
        id: output(
          name.endsWith('DataDisk') ? 'vol-' + createHash('sha256').update(name).digest('hex').slice(0, 17) : name,
        ),
        name: output(name),
        arn: output(`${name}-arn`),
      })
    }
  }
  const constructors = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'getAmiOutput'
          ? () => ({ id: output('ami') })
          : name === 'getSubnetOutput'
            ? () => ({ availabilityZone: output('us-east-1a') })
            : Resource,
    },
  )
  const globals = {
    gcp: new Proxy({}, { get: () => constructors }),
    aws: new Proxy({}, { get: () => constructors }),
    command: { local: constructors },
    $app: { name: 'boxlite-app', stage: 'dev' },
    $util: { output, secret: output },
    $resolve: (values: any[]) => output(values.map(unwrap)),
  }
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() =>
      previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key),
    )
  }
  return { resources, output }
}

const requestFor = (size: RunnerRequest['size'] = 'large'): RunnerRequest => ({
  size,
  rootDiskGb: 100,
  nestedVirtualization: true,
  fleet: [
    {
      slot: { resourceName: 'Runner', nameTag: 'boxlite-app-dev-runner', controlPlaneRunnerName: 'default' },
      token: 'runner-token',
    },
  ],
  binary: {
    source: 'release',
    identity: '0.11.0',
    transport: 'https',
    tarballUrl: 'https://example.invalid/runner.tar.gz',
    checksumUrl: 'https://example.invalid/runner.tar.gz.sha256',
    tarballName: 'runner.tar.gz',
  },
  apiUrl: 'https://api.example.invalid',
  otlpUrl: 'http://otel:4317',
  registryProxyHost: null,
  checkpointBucket: null,
  environment: {},
  secrets: {},
})

const common = { artifactsBucket: 'artifacts', adminApiKey: 'admin', regionId: 'region', dependsOn: [] }

const gcpProvider = (output: (value: any) => any) =>
  gcpRunnerProvider({
    ...common,
    project: 'project',
    zone: 'us-east5-a',
    volumePrefix: 'boxlite-volume',
    placement: { cloud: 'gcp', subnetwork: output('subnet'), serviceAccount: output('runner@example.invalid') } as any,
  })

test('GCP checkpoint object access names only the configured archive bucket', (t) => {
  const { resources, output } = captureResources(t)
  const provider = gcpProvider(output)
  const bucket = output('boxlite-app-dev-checkpoints')
  provider({ ...requestFor(), checkpointBucket: bucket })

  const grant = resources.get('RunnerCheckpointObjects')!
  assert.ok(grant)
  assert.equal(grant.args.bucket, bucket)
  assert.equal(grant.args.role, 'roles/storage.objectUser')
  assert.equal(grant.args.member.value, 'serviceAccount:runner@example.invalid')
  assert.equal('project' in grant.args, false)

  resources.clear()
  provider(requestFor())
  assert.equal(resources.has('RunnerCheckpointObjects'), false)
})

test('GCP keeps existing machine types while supplying the requested size for new hosts', (t) => {
  const { resources, output } = captureResources(t)
  const provider = gcpProvider(output)
  for (const [size, machineType] of [
    ['small', 'n4-standard-4'],
    ['large', 'n4-standard-16'],
  ] as const) {
    provider(requestFor(size))
    const host = resources.get('Runner')!
    assert.equal(host.args.machineType, machineType)
    assert.deepEqual(host.options.ignoreChanges, ['machineType', 'bootDisk', 'metadataStartupScript', 'attachedDisks'])
    assert.equal(host.args.deletionProtection, true)
    assert.equal(host.options.protect, true)
  }
})

test('GCP honors an explicit data disk capacity and retains the default and disk protections', (t) => {
  const { resources, output } = captureResources(t)
  const provider = gcpProvider(output)
  const request = { ...requestFor(), dataDiskGb: 2048 }
  provider(request)
  const disk = resources.get('RunnerData')!
  assert.equal(disk.args.size, 2048)
  assert.equal(disk.args.provisionedIops, 3600)
  assert.equal(disk.args.provisionedThroughput, 290)
  assert.deepEqual(disk.options.ignoreChanges, ['size', 'provisionedIops', 'provisionedThroughput'])
  assert.equal(disk.options.protect, true)
  for (const size of ['small', 'medium', 'large'] as const) {
    provider(requestFor(size))
    assert.equal(resources.get('RunnerData')!.args.size, 200)
  }
})

const awsProvider = () =>
  awsRunnerProvider({
    ...common,
    accountId: '123456789012',
    region: 'us-east-1',
    placement: { cloud: 'aws', exposure: 'egress-only-public', subnets: ['subnet'], securityGroups: [] } as any,
  })

test('AWS provisions an independently retained encrypted gp3 disk for each host', (t) => {
  const { resources } = captureResources(t)
  const provider = awsProvider()
  provider({ ...requestFor(), dataDiskGb: 2048 })
  const disk = resources.get('RunnerDataDisk')!
  assert.equal(disk.args.size, 2048)
  assert.equal(disk.args.type, 'gp3')
  assert.equal(disk.args.encrypted, true)
  assert.deepEqual(disk.options.ignoreChanges, ['size', 'iops', 'throughput'])
  assert.equal(disk.options.protect, true)
  assert.equal(disk.options.retainOnDelete, true)
  const attachment = resources.get('RunnerDataAttachment')!
  assert.equal(attachment.args.volumeId, disk.resource.id)
  assert.equal(attachment.options.protect, true)
  const host = resources.get('Runner')!
  assert.equal(host.args.rootBlockDevice.volumeSize, 100)
  const boot = Buffer.from(host.args.userDataBase64.value, 'base64').toString()
  assert.ok(boot.includes('RUNNER_DATA_DISK_PROVIDER=aws'))
  assert.ok(boot.includes('RUNNER_DATA_DISK_NAME=' + disk.resource.id.value))
})

test('AWS observes one canary then runs bounded batches with barriers', (t) => {
  const { resources } = captureResources(t)
  for (const count of [1, 4, 8, 16]) {
    resources.clear()
    const request = requestFor()
    request.fleet = Array.from({ length: count }, (_, index) => ({
      slot: {
        resourceName: index ? `Runner-runner-${index + 1}` : 'Runner',
        nameTag: `boxlite-app-dev-runner-${index + 1}`,
        controlPlaneRunnerName: `runner-${index + 1}`,
      },
      token: 'token',
    }))
    awsProvider()(request)
    const checks = [...resources]
      .filter(([name]) => name.startsWith('CheckRunnerHealth'))
      .map(([, value]) => value.resource)
    const upgrades = [...resources].filter(([name]) => name.startsWith('UpgradeRunnerBinary')).map(([, value]) => value)
    assert.equal(upgrades.length, count)
    assert.deepEqual(upgrades[0].options.dependsOn.slice(1), checks)
    assert.match(
      Buffer.from(upgrades[0].args.environment.RUNNER_UPGRADE_PAYLOAD.value, 'base64').toString(),
      /canary_deadline=\$\(\(SECONDS \+ 300\)\)/,
    )
    const size = Math.min(4, Math.max(1, Math.floor(count / 4)))
    for (let index = 1; index < count; index++) {
      const first = 1 + Math.floor((index - 1) / size) * size
      const prior =
        first === 1
          ? [upgrades[0].resource]
          : upgrades.slice(Math.max(1, first - size), first).map((value) => value.resource)
      assert.deepEqual(upgrades[index].options.dependsOn.slice(1), prior)
    }
  }
})

test('AWS supplies the registry proxy and checkpoint bucket to boot and update together', (t) => {
  const { resources, output } = captureResources(t)
  awsProvider()({
    ...requestFor(),
    checkpointBucket: output('checkpoint-bucket'),
    registryProxyHost: 'registry.example.com',
    environment: {
      ...requestFor().environment,
      BOXLITE_RUNNER_ENV: '{"BOXLITE_EXPERIMENTAL":"nested-virtualization"}',
    },
  })
  const boot = Buffer.from(resources.get('Runner')!.args.userDataBase64.value, 'base64').toString()
  const update = Buffer.from(
    resources.get('UpgradeRunnerBinary')!.args.environment.RUNNER_UPGRADE_PAYLOAD.value,
    'base64',
  ).toString()
  for (const value of ['AWS_DEFAULT_BUCKET=checkpoint-bucket', 'REGISTRY_PROXY_HOST=registry.example.com']) {
    assert.ok(boot.includes(value))
    assert.ok(update.includes(value))
  }
  assert.ok(boot.includes('BOXLITE_EXPERIMENTAL="nested-virtualization"'))
  const managedBlock = update.match(/UNIT_ENV_CUSTOM=.*printf '%s' '([^']+)'/)?.[1]
  assert.ok(managedBlock, 'the update carries the managed environment block')
  assert.ok(Buffer.from(managedBlock, 'base64').toString().includes('BOXLITE_EXPERIMENTAL="nested-virtualization"'))
  const triggers = resources.get('UpgradeRunnerBinary')!.args.triggers
  assert.ok(triggers.includes(requestFor().apiUrl))
  assert.ok(triggers.includes(requestFor().otlpUrl))
  const grant = JSON.parse(resources.get('RunnerCheckpoints')!.args.policy.value)
  assert.deepEqual(
    grant.Statement.map((statement: any) => statement.Resource),
    [
      'arn:aws:s3:::checkpoint-bucket',
      ['arn:aws:s3:::checkpoint-bucket/checkpoints/*', 'arn:aws:s3:::checkpoint-bucket/box-migrations/*'],
    ],
  )
})

for (const [configured, granted] of [
  ['moving/boxes/', true],
  ['s3://checkpoint-bucket/moving/boxes', true],
  ['s3://external-bucket/moving/boxes', false],
] as const) {
  test('Runner archive grants respect the bucket boundary for ' + configured, (t) => {
    const { resources, output } = captureResources(t)
    awsProvider()({
      ...requestFor(),
      checkpointBucket: output('checkpoint-bucket'),
      migrationArchivePrefix: configured,
    })
    const policy = JSON.parse(resources.get('RunnerCheckpoints')!.args.policy.value)
    assert.equal(policy.Statement[1].Resource.includes('arn:aws:s3:::checkpoint-bucket/moving/boxes/*'), granted)
    assert.doesNotMatch(JSON.stringify(policy), /external-bucket/)
  })
}
