import assert from 'node:assert/strict'
import test from 'node:test'
import { readStackEnvironment } from '../src/stack-env.ts'
import type { RunnerRequest } from '../stack/runners.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import { awsRunnerProvider } from '../stack/providers/aws/runners.ts'

const fleetFor = (count: number) =>
  readStackEnvironment({
    app: 'boxlite-app',
    stage: 'dev',
    home: 'gcp',
    region: 'us-east5',
    environment: {
      BOXLITE_IMAGE_TAG: 'a'.repeat(40),
      STACK_DOMAIN: 'dev.example.com',
      PROXY_DOMAIN: 'box.dev.example.com',
      CLOUDFLARE_ZONE_ID: 'zone',
      OIDC_ISSUER_BASE_URL: 'https://auth.dev.example.com',
      OIDC_CLIENT_ID: 'client',
      RUNNERS: String(count),
      DEFAULT_RUNNER_NAME: 'default',
    },
    declaration: {
      groups: { deploy: [], api: ['OIDC_CLIENT_ID'], proxy: [], runner: [], 'otel-collector': [] },
      where: '/test',
    },
  }).runnerFleet

test('increasing the runner count preserves the existing host identities', () => {
  const before = fleetFor(2)
  const after = fleetFor(3)
  assert.deepEqual(after.slice(0, 2), before)
  assert.deepEqual(after[2], {
    resourceName: 'Runner-runner-3',
    nameTag: 'boxlite-app-dev-runner-3',
    controlPlaneRunnerName: 'runner-3',
  })
})

test('runner sizing is supplied at creation and ignored for existing hosts', async (t) => {
  // Capture production resource declarations; Pulumi state reconciliation is not mocked here.
  const unwrap = (value: any): any => value?.value ?? value
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  const resources = new Map<string, { args: any; options: any; resource: any }>()
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options, resource: this })
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
  const requestFor = (count: number, size: RunnerRequest['size'], disk: number): RunnerRequest => ({
    size,
    rootDiskGb: disk,
    nestedVirtualization: true,
    fleet: fleetFor(count).map((slot) => ({ slot, token: `token-${slot.controlPlaneRunnerName}` })),
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
  const common = {
    artifactsBucket: 'artifacts',
    adminApiKey: 'admin',
    regionId: 'region',
    dependsOn: [],
  }

  await t.test('GCP observes one runner for five minutes before rolling the remainder in parallel', () => {
    const provider = gcpRunnerProvider({
      ...common,
      project: 'project',
      zone: 'us-east5-a',
      volumePrefix: 'boxlite-volume',
      placement: { cloud: 'gcp', subnetwork: output('subnet'), serviceAccount: output('runner@example.test') } as any,
    })
    for (const count of [4, 1, 12]) {
      resources.clear()
      provider(requestFor(count, 'small', 100))
      const canary = resources.get('RunnerBinary')!
      assert.deepEqual(canary.args.instanceFilter.inclusionLabels, [{ labels: { 'boxlite-runner': 'default' } }])
      assert.equal(canary.args.name, 'boxlite-app-dev-runner-binary')
      assert.deepEqual(canary.args.rollout, { disruptionBudget: { fixed: 1 }, minWaitDuration: '300s' })
      assert.equal(canary.args.skipAwaitRollout, false)
      const fleet = resources.get('RunnerBinaryFleet')
      if (count === 1) {
        assert.equal(fleet, undefined)
        continue
      }
      assert.ok(fleet)
      assert.equal(fleet.args.name, 'boxlite-app-dev-runner-binary-fleet')
      assert.equal(fleet.args.instanceFilter.inclusionLabels.length, count - 1)
      assert.ok(
        fleet.args.instanceFilter.inclusionLabels.every((entry: any) => entry.labels['boxlite-runner'] !== 'default'),
      )
      assert.deepEqual(fleet.args.rollout, { disruptionBudget: { percent: 100 }, minWaitDuration: '0s' })
      assert.equal(fleet.args.skipAwaitRollout, false)
      assert.ok(fleet.options.dependsOn.includes(canary.resource))
      assert.deepEqual(fleet.args.osPolicies, canary.args.osPolicies)
    }
  })

  await t.test('GCP refuses normalized runner labels that would overlap the two rollout batches', () => {
    const provider = gcpRunnerProvider({
      ...common,
      project: 'project',
      zone: 'us-east5-a',
      volumePrefix: 'boxlite-volume',
      placement: { cloud: 'gcp', subnetwork: output('subnet'), serviceAccount: output('runner@example.test') } as any,
    })
    const request = requestFor(4, 'small', 100)
    request.fleet[0]!.slot.controlPlaneRunnerName = 'RUNNER.2'
    resources.clear()
    assert.throws(() => provider(request), /runner labels.*unique/)
    assert.equal(resources.size, 0)
  })

  await t.test('GCP freezes machine type and both disks while accepting new creation defaults', () => {
    resources.clear()
    const provider = gcpRunnerProvider({
      ...common,
      project: 'project',
      zone: 'us-east5-a',
      volumePrefix: 'boxlite-volume',
      placement: {
        cloud: 'gcp',
        exposure: 'egress-only-public',
        subnetwork: output('subnet'),
        serviceAccount: output('runner@example.test'),
      } as any,
    })
    provider(requestFor(2, 'small', 100))
    assert.equal(resources.get('Runner')!.args.machineType, 'n4-standard-4')
    assert.equal(resources.get('RunnerData')!.args.size, 200)
    provider({ ...requestFor(3, 'large', 120), dataDiskGb: 2048 })
    const added = resources.get('Runner-runner-3')!
    assert.equal(added.args.machineType, 'n4-standard-16')
    assert.equal(added.args.bootDisk.initializeParams.size, 120)
    assert.equal(resources.get('RunnerData-runner-3')!.args.size, 2048)
    for (const slot of fleetFor(3)) {
      const host = resources.get(slot.resourceName)!
      const disk = resources.get(slot.resourceName.replace('Runner', 'RunnerData'))!
      assert.ok(host.options.ignoreChanges.includes('machineType'), 'existing GCP CPU/memory must retain state')
      assert.ok(host.options.ignoreChanges.includes('bootDisk'))
      assert.ok(host.options.ignoreChanges.includes('attachedDisks'))
      for (const field of ['size', 'provisionedIops', 'provisionedThroughput']) {
        assert.ok(disk.options.ignoreChanges.includes(field))
      }
      assert.equal(host.args.deletionProtection, true)
      assert.equal(host.options.protect, true)
      assert.equal(disk.options.protect, true)
    }
  })

  await t.test('AWS freezes instance type and root disk size while accepting new creation defaults', () => {
    resources.clear()
    const provider = awsRunnerProvider({
      ...common,
      region: 'us-east-1',
      placement: {
        cloud: 'aws',
        exposure: 'egress-only-public',
        subnets: ['subnet'],
        securityGroups: [],
      } as any,
    })
    assert.throws(() => provider({ ...requestFor(3, 'large', 120), dataDiskGb: 2048 }), /do not support dataDiskGb/)
    assert.equal(resources.size, 0)
    provider(requestFor(2, 'small', 100))
    assert.equal(resources.get('Runner')!.args.instanceType, 'c8i.large')
    provider(requestFor(3, 'large', 120))
    const added = resources.get('Runner-runner-3')!
    assert.equal(added.args.instanceType, 'c8i.2xlarge')
    assert.equal(added.args.rootBlockDevice.volumeSize, 120)
    for (const slot of fleetFor(3)) {
      const host = resources.get(slot.resourceName)!
      assert.ok(host.options.ignoreChanges.includes('instanceType'), 'existing AWS CPU/memory must retain state')
      assert.ok(host.options.ignoreChanges.includes('rootBlockDevice.volumeSize'))
      assert.equal(host.options.protect, true)
    }
  })
})
