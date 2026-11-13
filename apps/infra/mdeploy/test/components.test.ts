import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as gcpSdk from '@pulumi/gcp'
import { loadConfig } from 'mstage/config'
import { resolveScope } from 'mstage/scope'
import { componentTargets, deploymentComponents, type DeployedResource } from '../src/components.ts'
import { runnerFleetFrom } from '../src/stack-env.ts'
import { gcpRunnerProvider } from '../stack/providers/gcp/runners.ts'
import { resolveRunnerBinary } from '../stack/runner-binary.ts'
import { gcpTarget, pulumiDeploy } from '../src/pulumi.ts'
import { awsTarget } from '../src/sst.ts'
import { run } from '../src/run.ts'

const environment = { MSTAGE_CONFIG: fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url)) }
const cwd = fileURLToPath(new URL('../..', import.meta.url))
const config = loadConfig({ cwd, environment })
const scope = resolveScope({ options: { stage: 'dev2' }, config, environment })
const app = scope.app!
const stage = scope.stage!
const prefix = `urn:pulumi:${stage}::${app}::`
const identity = { assertUsableFor: async () => {}, childEnvironment: async () => ({ env: {}, expiresAt: null }) }

class Value {
  constructor(readonly value: any) {}
  apply(fn: (input: any) => any): Value {
    return output(fn(this.value))
  }
}
const output = (input: any): Value => (input instanceof Value ? input : new Value(input))
const unwrap = (input: any): any =>
  input instanceof Value
    ? unwrap(input.value)
    : Array.isArray(input)
      ? input.map(unwrap)
      : input && typeof input === 'object'
        ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, unwrap(value)]))
        : input

/** Capture real provider constructor calls, taking resource types from the installed SDK. */
const runnerState = (count: number, build = false) => {
  const resources: (DeployedResource & { name: string; options: any })[] = []
  const namespace = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_target, key) => namespace([...path, String(key)]),
      construct: (_target, [name, args, options]) => {
        const type = path.reduce((value: any, key) => value[key], gcpSdk).__pulumiType as string
        const resource = { name, type, urn: `${prefix}${type}::${name}`, inputs: unwrap(args), options }
        resources.push(resource)
        return { id: output(name), name: output(args.name ?? name) }
      },
    })
  Object.assign(globalThis, {
    $app: { name: app, stage },
    $util: { output, secret: output },
    $resolve: (items: any) => output(unwrap(items)),
    gcp: namespace([]),
    command: { local: { Command: class {} } },
  })
  const values = { RUNNERS: String(count) }
  const binary = resolveRunnerBinary({
    environment: build ? { RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: 'a'.repeat(40) } : {},
    configRoot: config.root,
    staging: { cloud: 'gcp', bucket: 'test-artifacts' },
  })
  gcpRunnerProvider({
    project: scope.project!,
    zone: scope.zone ?? `${scope.region}-a`,
    artifactsBucket: 'test-artifacts',
    volumePrefix: 'test-volume',
    adminApiKey: 'synthetic-admin',
    regionId: 'test-region',
    dependsOn: [],
    placement: { cloud: 'gcp', serviceAccount: output('runner@example.test'), subnetwork: output('subnet') } as any,
  })({
    size: 'small',
    rootDiskGb: 100,
    nestedVirtualization: true,
    binary,
    fleet: runnerFleetFrom({ environment: values, app, stage }).map((slot) => ({ slot, token: 'synthetic-token' })),
    apiUrl: 'https://api.example.test',
    otlpUrl: 'https://otel.example.test',
    registryProxyHost: null,
    checkpointBucket: null,
    environment: {},
    secrets: {},
  })
  return resources
}
const apiState = (): DeployedResource[] => [
  { type: (gcpSdk.cloudrunv2.Service as any).__pulumiType, urn: `${prefix}gcp:cloudrunv2/service:Service::Api` },
  {
    type: (gcpSdk.cloudrunv2.Service as any).__pulumiType,
    urn: `${prefix}gcp:cloudrunv2/service:Service::OtelCollector`,
  },
]

test('component selection defaults to the full graph and rejects invalid or unsupported scopes', () => {
  assert.equal(deploymentComponents({ home: 'aws' }), 'api+runner')
  for (const value of ['', 'all', 'proxy', true, []])
    assert.throws(() => deploymentComponents({ home: 'gcp', value }), /--components must/)
  for (const value of ['api', 'runner']) {
    assert.throws(() => deploymentComponents({ home: 'aws', value }), /AWS\/SST does not support/)
    for (const intent of ['remove', 'refresh'] as const)
      assert.throws(() => deploymentComponents({ home: 'gcp', value, intent }), /deploy and --diff only/)
  }
})

for (const count of [1, 2])
  test(`Runner targets come from actual provider identities (${count} hosts)`, () => {
    const resources = runnerState(count)
    const targets = componentTargets({
      components: 'runner',
      app,
      stage,
      resources,
      environment: { RUNNERS: String(count) },
    })
    assert.deepEqual(
      targets.slice(0, -1),
      resources.filter((r) => r.type === 'gcp:osconfig/osPolicyAssignment:OsPolicyAssignment').map((r) => r.urn),
    )
    assert.ok(
      targets.at(-1)?.endsWith('::RunnerArtifactsRead*'),
      'the initially absent artifact grant must be targeted too',
    )
    assert.ok(targets.every((urn) => !urn.includes('compute/instance')))
  })

test('build-mode policies wait directly for artifact access, then canary before fleet', () => {
  const resources = runnerState(2, true)
  const grant = resources.find((r) => r.name === 'RunnerArtifactsRead')!
  const policies = resources.filter((r) => r.type === 'gcp:osconfig/osPolicyAssignment:OsPolicyAssignment')
  assert.ok(grant, 'the production provider must create artifact access')
  const targets = componentTargets({ components: 'runner', app, stage, resources, environment: { RUNNERS: '2' } })
  assert.ok(grant.urn.startsWith(targets.at(-1)!.slice(0, -1)), 'the target must match the real grant resource type')
  for (const policy of policies) {
    assert.ok(policy.options.dependsOn.some((dependency: any) => unwrap(dependency.id) === grant.name))
    assert.equal((policy.inputs as any).skipAwaitRollout, false)
  }
  assert.ok(policies[1]!.options.dependsOn.some((dependency: any) => unwrap(dependency.id) === policies[0]!.name))
})

test('Runner-only updates refuse fleet expansion, contraction and renamed membership', () => {
  for (const [deployed, requested] of [
    [1, 2],
    [2, 1],
  ])
    assert.throws(
      () =>
        componentTargets({
          components: 'runner',
          app,
          stage,
          resources: runnerState(deployed!),
          environment: { RUNNERS: String(requested) },
        }),
      /full --components api\+runner/,
    )
  assert.throws(
    () =>
      componentTargets({
        components: 'runner',
        app,
        stage,
        resources: runnerState(1),
        environment: { DEFAULT_RUNNER_NAME: 'renamed' },
      }),
    /full --components api\+runner/,
  )
  const resources = runnerState(1)
  resources.find((r) => r.name === 'RunnerBinary')!.inputs!.instanceFilter!.inclusionLabels = []
  assert.throws(
    () => componentTargets({ components: 'runner', app, stage, resources, environment: {} }),
    /full --components api\+runner/,
  )
})

test('missing, deleted and foreign-stack workloads never become empty or full target sets', () => {
  for (const resources of [
    [],
    apiState().map((r) => ({ ...r, delete: true })),
    apiState().map((r) => ({ ...r, urn: r.urn.replace(`:${stage}::`, ':foreign::') })),
  ])
    assert.throws(
      () => componentTargets({ components: 'api', app, stage, resources, environment: {} }),
      /full --components api\+runner/,
    )
})

for (const components of ['api', 'runner', 'api+runner'] as const) {
  for (const intent of ['diff', 'deploy'] as const)
    test(`CLI forwards ${components} through the GCP adapter to ${intent}`, async () => {
      const calls: { method: string; options: any }[] = []
      const logs: string[] = []
      const resources = [...apiState(), ...runnerState(1)]
      const result = await run({
        argv: ['--stage', stage, '--components', components, ...(intent === 'diff' ? ['--diff'] : [])],
        environment,
        cwd,
        checkLogin: async () => 0,
        log: (line) => logs.push(line),
        fetchEnv: async () => ({ source: 'fixture', values: { PULUMI_CONFIG_PASSPHRASE: 'synthetic-passphrase' } }),
        targetWith: async ({ config, scope }) =>
          gcpTarget({
            config,
            scope,
            identity,
            backend: {} as any,
            stateBucket: async () => 'test-state',
            createStackWith: async (input) => {
              assert.equal(input.selectOnly, components === 'api+runner' ? undefined : true)
              return {
                setAllConfig: async () => {},
                exportStack: async () => ({ deployment: { resources } }),
                preview: async (options) => {
                  calls.push({ method: 'diff', options })
                },
                up: async (options) => {
                  calls.push({ method: 'deploy', options })
                },
                destroy: async () => assert.fail('destroy'),
                refresh: async () => assert.fail('refresh'),
              }
            },
          }),
      })
      assert.equal(result, 0)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.method, intent)
      const actual = calls[0]!.options
      if (components === 'api+runner') assert.equal(actual.target, undefined)
      else {
        assert.deepEqual(actual.target, componentTargets({ components, app, stage, resources, environment: {} }))
        assert.equal(actual.targetDependents, false)
        if (components === 'api')
          assert.ok(
            actual.target.some((urn: string) => urn.endsWith('::ApiSecretAccess-*')),
            'new API secret grants need not exist in old state',
          )
      }
      assert.ok(logs.every((line) => !line.includes('synthetic-passphrase')))
    })
}

test('AWS adapter refuses a scoped request before identity resolution or SST spawn', async () => {
  const target = awsTarget({
    config,
    scope,
    backend: {} as any,
    identity: {
      assertUsableFor: async () => assert.fail('identity used'),
      credentials: async () => assert.fail('credentials used'),
    },
    spawnProcess: (() => assert.fail('SST spawned')) as any,
  })
  await assert.rejects(target.run({ components: 'api', log: () => {} }), /AWS\/SST does not support/)
})

test('a missing scoped workload is refused before config writes or engine updates', async () => {
  const calls: string[] = []
  await assert.rejects(
    pulumiDeploy({
      intent: 'deploy',
      components: 'api',
      config,
      scope,
      identity,
      state: { bucket: 'test-state' },
      stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'synthetic-passphrase', STACK_DOMAIN: 'example.test' },
      lookupAuthorizations: () => assert.fail('unrelated DNS preflight ran'),
      log: () => {},
      createStackWith: async () => ({
        exportStack: async () => ({ deployment: { resources: [] } }),
        setAllConfig: async () => {
          calls.push('config')
        },
        up: async () => {
          calls.push('up')
        },
        preview: async () => {
          calls.push('preview')
        },
        destroy: async () => {},
        refresh: async () => {},
      }),
    }),
    /full --components api\+runner/,
  )
  assert.deepEqual(calls, [])
})

test('protected-stage confirmation remains required with the new selection parameter', async () => {
  await assert.rejects(
    run({
      argv: ['--stage', 'prod', '--components', 'api+runner'],
      environment,
      cwd,
      checkLogin: async () => 0,
      targetWith: async () => assert.fail('target resolved before confirmation'),
    }),
    /protected.*--confirm/,
  )
})

test('invalid CLI selections stop before login and stage-store access', async () => {
  for (const argv of [
    ['--stage', 'dev', '--components', 'api'],
    ['--stage', stage, '--components', 'proxy'],
    ['--stage', stage, '--components', 'runner', '--remove', '--confirm'],
    ['--stage', stage, '--components', 'api', '--refresh'],
  ])
    await assert.rejects(
      run({
        argv,
        environment,
        cwd,
        checkLogin: async () => assert.fail('login used'),
        fetchEnv: async () => assert.fail('store used'),
      }),
      /AWS\/SST does not support|--components/,
    )
})
