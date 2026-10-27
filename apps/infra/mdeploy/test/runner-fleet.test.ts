import assert from 'node:assert/strict'
import test from 'node:test'
import { readStackEnvironment } from '../src/stack-env.ts'
import type { RunnerSettings } from '../src/config.ts'
import type { RunnerRequest } from '../stack/runners.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import { awsRunnerProvider } from '../stack/providers/aws/runners.ts'

const settings: RunnerSettings = {
  size: 'small',
  rootDiskGb: 100,
  primary: 'default',
  instances: [
    { slot: 1, name: 'default' },
    { slot: 2, name: 'runner-2' },
    { slot: 3, name: 'runner-3', size: 'large', rootDiskGb: 120, dataDiskGb: 2048 },
  ],
}
const fleetFor = (runners: RunnerSettings) =>
  readStackEnvironment({
    app: 'boxlite-app',
    stage: 'dev',
    home: 'gcp',
    region: 'us-east5',
    runners,
    environment: {
      BOXLITE_IMAGE_TAG: 'a'.repeat(40),
      STACK_DOMAIN: 'dev.example.com',
      PROXY_DOMAIN: 'box.dev.example.com',
      CLOUDFLARE_ZONE_ID: 'zone',
      OIDC_ISSUER_BASE_URL: 'https://auth.dev.example.com',
      OIDC_CLIENT_ID: 'client',
      RUNNERS: 'invalid-ignored-in-explicit-mode',
      DEFAULT_RUNNER_NAME: 'stale-default',
    },
    declaration: {
      groups: { deploy: [], api: ['OIDC_CLIENT_ID'], proxy: [], runner: [], 'otel-collector': [] },
      where: '/test',
    },
  }).runnerFleet

test('explicit slots survive primary selection and removal of earlier hosts', () => {
  const before = fleetFor(settings)
  const switched = fleetFor({ ...settings, primary: 'runner-3' })
  const after = fleetFor({ ...settings, primary: 'runner-3', instances: settings.instances!.slice(2) })
  assert.equal(before[0].resourceName, 'Runner')
  assert.equal(before[1].nameTag, 'boxlite-app-dev-runner-2')
  assert.equal(after[0].resourceName, 'Runner-runner-3')
  assert.equal(after[0].nameTag, 'boxlite-app-dev-runner-3')
  assert.deepEqual(after, [before[2]])
  assert.deepEqual(switched, [before[2], before[0], before[1]])
})

test('providers receive independent host sizes while retaining disks and protection', (t) => {
  // Record constructor arguments at the provider boundary. No cloud API or command runs.
  const unwrap = (value: any): any => value?.value ?? value
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  const resources = new Map<string, { args: any; options: any }>()
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options })
      Object.assign(this, args, { id: output(name), name: output(name), arn: output(`${name}-arn`) })
    }
  }
  const constructors = new Proxy(
    {},
    { get: (_, name) => (name === 'getAmiOutput' ? () => ({ id: output('ami') }) : Resource) },
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
  const requestFor = (runners: RunnerSettings): RunnerRequest => ({
    ...runners,
    nestedVirtualization: true,
    fleet: fleetFor(runners).map((slot) => ({ slot, token: `token-${slot.controlPlaneRunnerName}` })),
    binary: {
      source: 'release',
      identity: '0.10.8',
      transport: 'https',
      tarballUrl: 'https://example.com/runner.tar.gz',
      checksumUrl: 'https://example.com/runner.tar.gz.sha256',
      tarballName: 'runner.tar.gz',
    },
    apiUrl: 'https://api.dev.example.com',
    otlpUrl: 'http://otel:4317',
    registryProxyHost: null,
    snapshotBucket: null,
    environment: {},
    secrets: {},
  })
  const gcp = gcpRunnerProvider({
    project: 'project',
    zone: 'us-east5-a',
    artifactsBucket: 'artifacts',
    volumePrefix: 'boxlite-volume',
    adminApiKey: 'admin',
    regionId: 'region',
    dependsOn: [],
    placement: {
      cloud: 'gcp',
      exposure: 'egress-only-public',
      subnetwork: output('subnet'),
      serviceAccount: output('runner@example.test'),
    } as any,
  })
  gcp(requestFor(settings))
  assert.equal(resources.get('Runner')!.args.machineType, 'n4-standard-4')
  assert.equal(resources.get('Runner-runner-2')!.args.machineType, 'n4-standard-4')
  assert.equal(resources.get('RunnerData')!.args.size, 200)
  const survivor = resources.get('Runner-runner-3')!
  const disk = resources.get('RunnerData-runner-3')!
  assert.equal(survivor.args.machineType, 'n4-standard-16')
  assert.equal(survivor.args.bootDisk.initializeParams.size, 120)
  assert.equal(disk.args.size, 2048)
  assert.equal(disk.args.name, 'boxlite-app-dev-runner-data-3')
  assert.equal(unwrap(survivor.args.attachedDisks[0].source), 'RunnerData-runner-3')
  assert.equal(survivor.args.deletionProtection, true)
  assert.equal(survivor.options.protect, true)
  assert.equal(disk.options.protect, true)
  assert.ok(survivor.options.ignoreChanges.includes('attachedDisks'))
  assert.ok(disk.options.ignoreChanges.includes('size'))
  resources.clear()
  gcp(requestFor({ ...settings, primary: 'runner-3', instances: settings.instances!.slice(2) }))
  assert.ok(!resources.has('Runner'))
  assert.deepEqual(resources.get('RunnerData-runner-3'), disk)
  assert.equal(resources.get('Runner-runner-3')!.args.name, survivor.args.name)
  assert.equal(
    unwrap(resources.get('Runner-runner-3')!.args.metadataStartupScript),
    unwrap(survivor.args.metadataStartupScript),
  )
  gcp(
    requestFor({
      size: 'medium',
      rootDiskGb: 100,
      dataDiskGb: 512,
      primary: 'default',
      instances: [{ slot: 1, name: 'default' }],
    }),
  )
  assert.equal(resources.get('RunnerData')!.args.size, 512)

  const aws = awsRunnerProvider({
    region: 'us-east-1',
    artifactsBucket: 'artifacts',
    adminApiKey: 'admin',
    regionId: 'region',
    dependsOn: [],
    placement: { cloud: 'aws', exposure: 'egress-only-public', subnets: ['subnet'], securityGroups: [] } as any,
  })
  resources.clear()
  assert.throws(() => aws(requestFor(settings)), /do not support dataDiskGb/)
  assert.equal(resources.size, 0, 'reject unsupported storage before declaring any resources')
  const awsSettings = { ...settings, instances: settings.instances!.map(({ dataDiskGb: _, ...instance }) => instance) }
  assert.throws(() => aws(requestFor({ ...awsSettings, dataDiskGb: 512 })), /do not support dataDiskGb/)
  aws(requestFor(awsSettings))
  assert.equal(resources.get('Runner')!.args.instanceType, 'c8i.large')
  assert.equal(resources.get('Runner-runner-3')!.args.instanceType, 'c8i.2xlarge')
  assert.equal(resources.get('Runner-runner-3')!.args.rootBlockDevice.volumeSize, 120)
})
