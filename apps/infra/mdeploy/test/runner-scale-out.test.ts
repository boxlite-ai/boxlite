import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunnerRequest } from '../stack/runners.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import { resolveRunnerBinary } from '../stack/runner-binary.ts'

test('GCP rollout batches observe one host before updating the fleet', async (t) => {
  const output = (value: any): any => ({ value, apply: (fn: (value: any) => any) => output(fn(value)) })
  const resources = new Map<string, { args: any; options: any; resource: any }>()
  class Resource {
    [key: string]: any
    constructor(name: string, args: any, options: any = {}) {
      resources.set(name, { args, options, resource: this })
      Object.assign(this, args, { id: output(name), name: output(name) })
    }
  }
  const constructors = new Proxy({}, { get: () => Resource })
  const globals = {
    gcp: new Proxy({}, { get: () => constructors }),
    command: { local: constructors },
    $app: { name: 'boxlite-app', stage: 'dev' },
    $util: { output, secret: output },
    $resolve: (values: any[]) => output(values.map((value) => value?.value ?? value)),
  }
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() =>
      previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key),
    )
  }
  const provider = gcpRunnerProvider({
    project: 'project',
    zone: 'us-east5-a',
    volumePrefix: 'boxlite-volume',
    artifactsBucket: 'artifacts',
    adminApiKey: 'admin',
    regionId: 'region',
    dependsOn: [],
    placement: { cloud: 'gcp', subnetwork: output('subnet'), serviceAccount: output('runner@example.test') } as any,
  })
  const requestFor = (count: number): RunnerRequest => ({
    size: 'small',
    rootDiskGb: 100,
    nestedVirtualization: true,
    fleet: Array.from({ length: count }, (_, index) => ({
      slot: {
        resourceName: index ? `Runner-runner-${index + 1}` : 'Runner',
        nameTag: `boxlite-app-dev-runner${index ? `-${index + 1}` : ''}`,
        controlPlaneRunnerName: index ? `runner-${index + 1}` : 'default',
      },
      token: 'test-token',
    })),
    binary: resolveRunnerBinary({ environment: {}, configRoot: '.', readVersion: () => '0.10.8' }),
    apiUrl: 'https://api.dev.example.com',
    otlpUrl: 'http://otel:4317',
    registryProxyHost: null,
    environment: {},
    secrets: {},
  })
  await t.test('GCP observes the first runner then updates every other runner in parallel', () => {
    for (const count of [4, 1, 12]) {
      resources.clear()
      provider(requestFor(count))
      const canary = resources.get('RunnerBinary')!
      assert.deepEqual(canary.options.customTimeouts, { create: '40m', update: '40m' })
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
      assert.deepEqual(fleet.options.customTimeouts, { create: '40m', update: '40m' })
      assert.equal(fleet.args.name, 'boxlite-app-dev-runner-binary-fleet')
      assert.deepEqual(
        fleet.args.instanceFilter.inclusionLabels,
        Array.from({ length: count - 1 }, (_, index) => ({
          labels: { 'boxlite-runner': `runner-${index + 2}` },
        })),
      )
      assert.deepEqual(fleet.args.rollout, { disruptionBudget: { percent: 100 }, minWaitDuration: '0s' })
      assert.equal(fleet.args.skipAwaitRollout, false)
      assert.ok(fleet.options.dependsOn.includes(canary.resource))
      assert.deepEqual(fleet.args.osPolicies, canary.args.osPolicies)
    }
  })
  await t.test('GCP refuses normalized labels that would overlap the two batches', () => {
    const request = requestFor(4)
    request.fleet[0]!.slot.controlPlaneRunnerName = 'RUNNER.2'
    resources.clear()
    assert.throws(() => provider(request), /runner labels.*unique/)
    assert.equal(resources.size, 0)
  })
})
