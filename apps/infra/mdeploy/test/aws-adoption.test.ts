import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { nativeImportDocument, adoptionPreview, assertAwsAdoptionInventory } from '../src/aws-adoption.ts'
import { migrateAws } from '../src/migrate-aws.ts'

const app = 'boxlite-app',
  stage = 'dev'
const prefix = `urn:pulumi:${stage}::${app}::`
test('native state import refuses raw SST files, foreign identities and unfinished operations', () => {
  const resource = {
    type: 'aws:rds/instance:Instance',
    urn: prefix + 'aws:rds/instance:Instance::DatabaseInstance',
    custom: true,
    id: 'db-existing',
  }
  const document = { version: 3, deployment: { resources: [resource] } }
  assert.deepEqual(nativeImportDocument(JSON.stringify(document), app, stage), document)
  for (const value of [
    { version: 3, checkpoint: { latest: { resources: [resource] } } },
    { ...document, deployment: { resources: [] } },
    { ...document, deployment: { resources: [resource, resource] } },
    {
      ...document,
      deployment: {
        resources: [{ ...resource, urn: resource.urn.replace('::dev', '::prod').replace('pulumi:dev', 'pulumi:prod') }],
      },
    },
    { ...document, deployment: { resources: [{ ...resource, id: '' }] } },
    { ...document, deployment: { resources: [resource], pending_operations: [{}] } },
  ])
    assert.throws(() => nativeImportDocument(JSON.stringify(value), app, stage))
})

test('adoption requires every incumbent stateful object and unchanged frozen source bytes', async () => {
  const resources = [
    { type: 'aws:rds/instance:Instance', custom: true, id: 'db-existing' },
    { type: 'aws:s3/bucketV2:BucketV2', custom: true, id: 'existing-storage' },
  ]
  const legacy = Buffer.from(JSON.stringify({ checkpoint: { latest: { resources } } }))
  const digest = createHash('sha256').update(legacy).digest('hex')
  let imported = resources
  let source = legacy
  const backend = {
    ownership: { inspect: async () => ({ sourceDigests: { boxlite: digest } }) },
    state: {
      readLegacyCheckpoint: async ({ app }: { app: string }) => (app === 'boxlite' ? source : null),
      readCheckpoint: async () => Buffer.from(JSON.stringify({ checkpoint: { latest: { resources: imported } } })),
    },
  } as any
  const environment = {
    AWS_PULUMI_MIGRATION: JSON.stringify({ boxlite: digest }),
    AWS_DATABASE_PASSWORD_SECRET_ARN: 'database',
    AWS_CACHE_PASSWORD_SECRET_ARN: 'cache',
    AWS_VOLUME_ACCESS_ROLE_NAME: 'boxlite-dev-s3-access',
  }
  const invoke = () => assertAwsAdoptionInventory({ backend, app, stage, environment })
  await invoke()
  imported = resources.slice(0, 1)
  await assert.rejects(invoke(), /missing incumbent aws:s3/)
  imported = resources
  source = Buffer.concat([legacy, Buffer.from(' ')])
  environment.AWS_PULUMI_MIGRATION = JSON.stringify({ boxlite: createHash('sha256').update(source).digest('hex') })
  await assert.rejects(invoke(), /changed after adoption/)
})

test('cutover requires complete preview evidence without replacement or deletion', () => {
  const check = adoptionPreview()
  assert.throws(check.assertReady, /no completion/)
  check.onEvent({ summaryEvent: {} } as any)
  check.assertReady()
  check.onEvent({
    resourcePreEvent: {
      metadata: {
        op: 'replace',
        type: 'aws:ecs/taskDefinition:TaskDefinition',
        urn: prefix + 'aws:ecs/taskDefinition:TaskDefinition::ApiTask',
      },
    },
  } as any)
  check.assertReady()
  check.onEvent({
    resourcePreEvent: { metadata: { op: 'replace', urn: prefix + 'aws:rds/instance:Instance::Database' } },
  } as any)
  assert.throws(check.assertReady, /replace or delete/)
})

test('migration refuses invalid actions and unconfirmed mutations before resolving cloud access', async () => {
  await assert.rejects(migrateAws({ argv: ['--action', 'deploy'], cwd: '/missing' }), /Migration --action/)
  for (const action of ['begin', 'import', 'refresh', 'cutover', 'rollback', 'unlock']) {
    await assert.rejects(migrateAws({ argv: ['--action', action], cwd: '/missing' }), /require --confirm/)
  }
})
