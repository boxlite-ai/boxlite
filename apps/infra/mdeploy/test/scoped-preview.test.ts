import assert from 'node:assert/strict'
import test from 'node:test'
import { pulumiDeploy } from '../src/pulumi.ts'

for (const home of ['aws', 'gcp'] as const) {
  const prefix = 'urn:pulumi:dev::fixture-app::'
  const apiType = home === 'aws' ? 'aws:ecs/service:Service' : 'gcp:cloudrunv2/service:Service'
  const apiName = home === 'aws' ? 'ApiService' : 'Api'
  const api = { type: apiType, urn: prefix + apiType + '::' + apiName }
  const resources =
    home === 'aws'
      ? [
          api,
          {
            type: 'aws:ecs/taskDefinition:TaskDefinition',
            urn: prefix + 'aws:ecs/taskDefinition:TaskDefinition::ApiTask',
          },
        ]
      : [api]
  const invoke = async (events: any[], complete = true) => {
    const calls: { kind: string; options?: any }[] = []
    const result = await pulumiDeploy({
      components: 'api',
      config: { root: '/fixture' },
      scope: {
        home,
        app: 'fixture-app',
        stage: 'dev',
        region: home === 'aws' ? 'us-east-1' : 'us-central1',
        project: home === 'gcp' ? 'fixture-project' : null,
      } as any,
      identity: { assertUsableFor: async () => {}, childEnvironment: async () => ({ env: {}, expiresAt: null }) },
      state: { bucket: 'fixture-state' },
      stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'fixture-only' },
      beforeMutation: async () => {
        calls.push({ kind: 'mark-native-attempt' })
      },
      log: () => {},
      createStackWith: async () => ({
        setAllConfig: async () => {},
        exportStack: async () => ({ deployment: { resources } }),
        preview: async (options) => {
          calls.push({ kind: 'preview', options })
          for (const event of events) options.onEvent!(event)
          if (complete) options.onEvent!({ summaryEvent: {} } as any)
        },
        up: async (options) => {
          calls.push({ kind: 'up', options })
        },
        refresh: async () => assert.fail('refresh'),
        destroy: async () => assert.fail('destroy'),
      }),
    })
    return { result, calls }
  }
  test(`${home} scoped apply follows a complete unfiltered refreshed preview`, async () => {
    const { result, calls } = await invoke([
      { resourcePreEvent: { metadata: { op: 'update', urn: api.urn, type: api.type } } },
      {
        resourcePreEvent: {
          metadata: { op: 'update', urn: prefix + 'pulumi:pulumi:Stack::root', type: 'pulumi:pulumi:Stack' },
        },
      },
    ])
    assert.equal(result, 0)
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['preview', 'mark-native-attempt', 'up'],
    )
    assert.equal(calls[0].options.target, undefined)
    assert.equal(calls[0].options.refresh, true)
    assert.ok(calls[2].options.target.includes(api.urn))
    assert.equal(calls[2].options.targetDependents, false)
  })
  test(`${home} scoped apply refuses provider changes, shared drift and incomplete preview evidence`, async () => {
    const providerType = 'pulumi:providers:' + (home === 'aws' ? 'aws' : 'gcp')
    const shared = prefix + 'shared:database:Database::database'
    const cases = [
      [
        {
          resourcePreEvent: {
            metadata: { op: 'update', type: providerType, urn: prefix + providerType + '::default' },
          },
        },
      ],
      [{ resourcePreEvent: { metadata: { op: 'replace', type: 'shared:database:Database', urn: shared } } }],
      [
        {
          resOutputsEvent: {
            metadata: {
              op: 'refresh',
              type: 'shared:database:Database',
              urn: shared,
              old: { id: 'disk', inputs: {}, outputs: { size: 100 } },
              new: { id: 'disk', inputs: {}, outputs: { size: 200 } },
            },
          },
        },
      ],
    ]
    for (const events of cases) {
      const { result, calls } = await invoke(events)
      assert.equal(result, 1)
      assert.deepEqual(
        calls.map((call) => call.kind),
        ['preview'],
      )
    }
    const { result, calls } = await invoke([], false)
    assert.equal(result, 1)
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['preview'],
    )
  })
}
