import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assertAwsMigrationReady } from '../src/aws-migration.ts'
import { awsTarget, pulumiDeploy, type StackFactory } from '../src/pulumi.ts'
import { awsResourceDefaults } from '../pulumi/aws-defaults.ts'
import type { StoreBackend } from 'mstage/env'

const legacy = Buffer.from('{"version":3,"checkpoint":{"latest":{"resources":[{"id":"db-existing"}]}}}')
const digest = createHash('sha256').update(legacy).digest('hex')
const native = Buffer.from(
  JSON.stringify({
    version: 3,
    checkpoint: { latest: { resources: [{ type: 'aws:rds/instance:Instance', custom: true, id: 'db-existing' }] } },
  }),
)
const environment = {
  AWS_VOLUME_ACCESS_ROLE_NAME: 'boxlite-dev-s3-access',
  AWS_PULUMI_MIGRATION: JSON.stringify({ boxlite: digest }),
  AWS_DATABASE_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:database',
  AWS_CACHE_PASSWORD_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:cache',
}
const backend = (old: Buffer | null = legacy, imported: Buffer | null = native) =>
  ({
    home: 'aws',
    read: async () => null,
    write: async () => {},
    currentVersion: async () => null,
    versions: async () => [],
    passphrase: async () => Buffer.alloc(32),
    state: {
      writeCheckpoint: async () => {},
      readLock: async () => null,
      removeLock: async () => {},
      readLegacyCheckpoint: async ({ app }: { app: string }) => (app === 'boxlite' ? old : null),
      readCheckpoint: async () => imported,
    },
  }) as StoreBackend
const check = (
  store: StoreBackend,
  values = environment,
  intent: 'deploy' | 'diff' | 'refresh' | 'remove' = 'deploy',
) => assertAwsMigrationReady({ backend: store, app: 'boxlite-app', stage: 'dev', intent, environment: values })

test('fresh AWS stages need no migration acknowledgement', async () => {
  await check(backend(null, null), {} as any)
})
test('SST stages refuse mutations before import and frozen-source acknowledgement', async () => {
  for (const intent of ['deploy', 'refresh', 'remove'] as const) {
    await assert.rejects(check(backend(), {} as any, intent), /reviewed native import/)
  }
  await assert.rejects(check(backend(), { ...environment, AWS_PULUMI_MIGRATION: '{' }), /JSON map/)
  await assert.rejects(check(backend(Buffer.concat([legacy, Buffer.from(' ')]))), /reviewed native import/)
  await assert.rejects(check(backend(legacy, null)), /must be imported/)
  await assert.rejects(
    check(backend(legacy, Buffer.from('{"checkpoint":{"latest":{"resources":[]}}}'))),
    /must be imported/,
  )
  await assert.rejects(check(backend(), { ...environment, AWS_CACHE_PASSWORD_SECRET_ARN: '' }), /adopt the existing/)
})
test('reviewed imports preserve credentials and allow a preview before acknowledgement', async () => {
  await check(backend())
  await check(backend(legacy, null), {} as any, 'diff')
})

test('AWS roles and buckets receive bounded physical prefixes without renaming imported identities', () => {
  const defaults = awsResourceDefaults({
    app: 'boxlite-app',
    stage: 'dev',
    accountId: '123456789012',
    protectedStage: true,
  })
  const role = defaults({ type: 'aws:iam/role:Role', name: 'ApiExecutionRole', props: {}, opts: {} } as any)
  assert.equal(role.props.namePrefix, 'boxlite-app-dev-apiexecutionrole-')
  assert.equal(role.props.permissionsBoundary, 'arn:aws:iam::123456789012:policy/boxlite-app-dev-runtime-boundary')
  assert.equal(role.opts.protect, true)
  assert.equal(role.opts.retainOnDelete, true)
  const imported = defaults({
    type: 'aws:iam/role:Role',
    name: 'ApiTaskRole',
    props: { name: 'existing-role' },
    opts: {},
  } as any)
  assert.equal(imported.props.name, 'existing-role')
  assert.equal(imported.props.namePrefix, undefined)
  const bucket = defaults({
    type: 'aws:s3/bucketV2:BucketV2',
    name: 'AnExtremelyLongPhysicalStorageBucketResource',
    props: {},
    opts: {},
  } as any)
  assert.ok(bucket.props.bucketPrefix.startsWith('boxlite-app-dev-'))
  assert.ok(bucket.props.bucketPrefix.length <= 37)
  assert.match(bucket.props.bucketPrefix, /^[a-z0-9-]+$/)
  for (const [type, property] of [
    ['aws:servicediscovery/privateDnsNamespace:PrivateDnsNamespace', 'name'],
    ['aws:sesv2/configurationSet:ConfigurationSet', 'configurationSetName'],
  ]) {
    const resource = defaults({ type, name: 'ImportedIdentity', props: {}, opts: {} } as any)
    assert.ok(resource.opts.ignoreChanges?.includes(property), `${type} must preserve its imported physical name`)
  }
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
test('the AWS target refuses an unacknowledged SST migration before starting Pulumi', async () => {
  const target = awsTarget({
    config: { root: '/repo' },
    scope,
    identity,
    backend: backend(),
    stateBucket: async () => assert.fail('state bucket resolved'),
    createStackWith: async () => assert.fail('Pulumi started'),
  })
  await assert.rejects(target.run({ log: () => {} }), /reviewed native import/)
})
