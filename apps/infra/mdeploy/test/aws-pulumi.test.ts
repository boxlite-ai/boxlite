import assert from 'node:assert/strict'
import test from 'node:test'
import { awsTarget, pulumiDeploy, type StackFactory } from '../src/pulumi.ts'
import { awsResourceDefaults } from '../pulumi/aws-defaults.ts'
import type { StoreBackend } from 'mstage/env'

test('AWS roles and buckets receive bounded physical prefixes and preserve explicitly declared names', () => {
  const defaults = awsResourceDefaults({
    app: 'boxlite-app',
    stage: 'dev',
    accountId: '123456789012',
    protectedStage: true,
  })
  const longScope = awsResourceDefaults({
    app: 'boxlite-app',
    stage: 'integration-aws',
    accountId: '123456789012',
    protectedStage: false,
  })
  for (const [type, property, limit] of [
    ['aws:iam/role:Role', 'namePrefix', 38],
    ['aws:s3/bucketV2:BucketV2', 'bucketPrefix', 37],
  ] as const) {
    const prefix = (name: string) => longScope({ type, name, props: {}, opts: {} } as any).props[property] as string
    assert.ok(prefix('ApiExecutionRole').startsWith('boxlite-app-integration-aws-'))
    assert.ok(prefix('ApiExecutionRole').length <= limit)
    assert.notEqual(prefix('ApiExecutionRole'), prefix('ApiExecutionPolicy'))
  }
  const role = defaults({ type: 'aws:iam/role:Role', name: 'ApiExecutionRole', props: {}, opts: {} } as any)
  assert.equal(role.props.namePrefix, 'boxlite-app-dev-apiexecutionrole-')
  assert.equal(role.props.permissionsBoundary, 'arn:aws:iam::123456789012:policy/boxlite-app-dev-runtime-boundary')
  assert.equal(role.opts.protect, true)
  assert.equal(role.opts.retainOnDelete, true)
  const named = defaults({
    type: 'aws:iam/role:Role',
    name: 'ApiTaskRole',
    props: { name: 'existing-role' },
    opts: {},
  } as any)
  assert.equal(named.props.name, 'existing-role')
  assert.equal(named.props.namePrefix, undefined)
  const bucket = defaults({
    type: 'aws:s3/bucketV2:BucketV2',
    name: 'AnExtremelyLongPhysicalStorageBucketResource',
    props: {},
    opts: {},
  } as any)
  assert.ok(bucket.props.bucketPrefix.startsWith('boxlite-app-dev-'))
  assert.ok(bucket.props.bucketPrefix.length <= 37)
  assert.match(bucket.props.bucketPrefix, /^[a-z0-9-]+$/)
  assert.deepEqual(defaults({ type: 'cloudflare:index/record:Record', name: 'Dns', props: {}, opts: {} } as any), {
    props: {},
    opts: {},
  })
})

test('protected AWS stages allow task revisions while retaining stateful resource protection', () => {
  const defaults = awsResourceDefaults({
    app: 'boxlite-app',
    stage: 'prod',
    accountId: '123456789012',
    protectedStage: true,
  })
  const revision = defaults({
    type: 'aws:ecs/taskDefinition:TaskDefinition',
    name: 'ApiTask',
    props: {},
    opts: {},
  } as any)
  assert.equal(revision.opts.protect, false, 'routine image/environment updates must be able to replace a revision')
  assert.equal(revision.opts.retainOnDelete, false, 'superseded revisions must be eligible for deregistration')
  for (const type of ['aws:rds/instance:Instance', 'aws:ebs/volume:Volume', 'aws:s3/bucketV2:BucketV2']) {
    const resource = defaults({ type, name: 'PersistentResource', props: {}, opts: {} } as any)
    assert.equal(resource.opts.protect, true, `${type} must retain deletion protection`)
    assert.equal(resource.opts.retainOnDelete, true, `${type} must retain its cloud object`)
  }
})

const scope = {
  app: 'boxlite-app',
  stage: 'dev',
  home: 'aws',
  region: 'us-east-1',
  protect: false,
  project: null,
} as any
const identity = {
  assertUsableFor: async () => {},
  childEnvironment: async () => ({ env: { AWS_REGION: 'wrong-region' }, expiresAt: null }),
}
test('AWS uses its S3 backend, region and provider configuration through Automation', async () => {
  const calls: string[] = []
  let selected: Parameters<StackFactory>[0] | undefined
  let configured: Record<string, { value: string }> | undefined
  await pulumiDeploy({
    intent: 'diff',
    config: { root: '/repo/apps/infra' },
    scope,
    identity,
    state: { bucket: 'stage-state' },
    stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'test-only' },
    log: () => {},
    lookupAuthorizations: () => assert.fail('GCP DNS lookup used'),
    createStackWith: async (input) => {
      selected = input
      return {
        setAllConfig: async (config: Record<string, { value: string }>) => {
          configured = config
        },
        preview: async () => {
          calls.push('preview')
        },
      } as any
    },
  })
  assert.equal(selected?.backendUrl, 's3://stage-state')
  assert.equal(selected?.envVars.AWS_REGION, 'us-east-1')
  assert.equal(configured?.['aws:region'].value, 'us-east-1')
  assert.equal(configured?.['gcp:project'], undefined)
  assert.deepEqual(calls, ['preview'])
})

test('a fresh AWS target starts Pulumi directly with its native backend', async () => {
  const calls: string[] = []
  const target = awsTarget({
    config: { root: '/fixture' },
    scope,
    identity,
    backend: {} as StoreBackend,
    stateBucket: async () => 'native-state',
    createStackWith: async ({ backendUrl }) => {
      assert.equal(backendUrl, 's3://native-state')
      return {
        setAllConfig: async () => {},
        exportStack: async () => assert.fail('full create does not require an existing checkpoint'),
        up: async () => {
          calls.push('up')
        },
        preview: async () => {},
        refresh: async () => {},
        destroy: async () => {},
      }
    },
  })
  assert.equal(await target.run({ stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'fixture' }, log: () => {} }), 0)
  assert.deepEqual(calls, ['up'])
})
