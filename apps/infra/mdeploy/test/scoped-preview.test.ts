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
  const invoke = async (intent: 'diff' | 'deploy') => {
    const calls: { kind: string; options?: any }[] = []
    const result = await pulumiDeploy({
      intent,
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
      log: () => {},
      createStackWith: async () => ({
        setAllConfig: async () => {},
        exportStack: async () => ({ deployment: { resources } }),
        preview: async (options) => {
          calls.push({ kind: 'preview', options })
          if (!options.target) {
            options.onEvent?.({
              resourcePreEvent: {
                metadata: {
                  op: 'update',
                  type: 'pulumi:providers:kubernetes',
                  urn: prefix + 'pulumi:providers:kubernetes::ProxyKubernetes',
                },
              },
            } as any)
            options.onEvent?.({ summaryEvent: {} } as any)
          }
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
  for (const intent of ['diff', 'deploy'] as const) {
    test(`${home} API ${intent} keeps its targets when an unrelated provider can update`, async () => {
      const { result, calls } = await invoke(intent)
      assert.equal(result, 0)
      assert.deepEqual(
        calls.map((call) => call.kind),
        intent === 'diff' ? ['preview'] : ['up'],
      )
      const { options } = calls.at(-1)!
      assert.ok(options.target.includes(api.urn))
      assert.equal(
        options.target.some((urn: string) => urn.includes('ProxyKubernetes')),
        false,
      )
      assert.equal(options.refresh, true)
      assert.equal(options.targetDependents, false)
    })
  }
}

test('AWS remove inspects stored protection before calling a mutating engine operation', async () => {
  for (const protect of [true, false]) {
    const calls: string[] = []
    const remove = () =>
      pulumiDeploy({
        intent: 'remove',
        config: { root: '/fixture' },
        scope: { home: 'aws', app: 'fixture-app', stage: 'dev', region: 'us-east-1', protect: false } as any,
        identity: { assertUsableFor: async () => {}, childEnvironment: async () => ({ env: {}, expiresAt: null }) },
        state: { bucket: 'fixture-state' },
        stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'fixture' },
        log: () => {},
        createStackWith: async () => ({
          exportStack: async () => ({
            deployment: { resources: [{ urn: 'urn:disk', type: 'aws:ebs/volume:Volume', protect }] },
          }),
          setAllConfig: async () => {},
          preview: async () => assert.fail('preview'),
          up: async () => assert.fail('up'),
          refresh: async () => assert.fail('refresh'),
          destroy: async () => {
            calls.push('destroy')
          },
        }),
      })
    if (protect) await assert.rejects(remove, /retained-data teardown/)
    else assert.equal(await remove(), 0)
    assert.deepEqual(calls, protect ? [] : ['destroy'])
  }
})
