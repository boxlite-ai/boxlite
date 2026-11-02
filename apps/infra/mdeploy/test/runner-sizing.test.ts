import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { awsRunnerProvider } from '../stack/providers/aws/runners.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import type { RunnerRequest } from '../stack/runners.ts'

// Record actual provider declarations; this does not simulate Pulumi state reconciliation.
const captureResources = (t: TestContext) => {
  const resources = new Map<string, { args: any; options: any }>()
  const unwrap = (value: any): any => value?.value ?? value
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options })
      Object.assign(this, args, { id: output(name), name: output(name), arn: output(`${name}-arn`) })
    }
  }
  const constructors = new Proxy(
    {},
    {
      get: (_, name) => (name === 'getAmiOutput' ? () => ({ id: output('ami') }) : Resource),
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

test('AWS refuses a GCP data disk size before creating resources', (t) => {
  const { resources } = captureResources(t)
  const provider = awsRunnerProvider({
    ...common,
    region: 'us-east-1',
    placement: { cloud: 'aws', exposure: 'egress-only-public', subnets: ['subnet'], securityGroups: [] } as any,
  })
  const request = { ...requestFor(), dataDiskGb: 2048 }
  assert.throws(() => provider(request), /AWS runners do not support dataDiskGb; configure rootDiskGb instead/)
  assert.equal(resources.size, 0)
  provider(requestFor())
  assert.equal(resources.get('Runner')!.args.rootBlockDevice.volumeSize, 100)
})
