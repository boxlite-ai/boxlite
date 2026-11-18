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

test('migration CLI snapshots private bytes and routes state-only operations through the ownership guard', async (t) => {
  const { mkdtemp, readFile, stat, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { writeStage } = await import('mstage/env')
  const directory = await mkdtemp(join(tmpdir(), 'aws-adoption-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const legacy = Buffer.from(JSON.stringify({ checkpoint: { latest: { resources: [] } } }))
  const digest = createHash('sha256').update(legacy).digest('hex')
  const signal = new AbortController().signal
  const events: string[] = []
  let sealed: Buffer | null = null
  let native: Buffer | null = null
  let phase = 'legacy'
  const backend = {
    home: 'aws',
    passphrase: async () => Buffer.alloc(32, 1),
    read: async () => sealed,
    write: async (input: { sealed: Buffer }) => {
      sealed = input.sealed
    },
    state: {
      readLegacyCheckpoint: async (scope: { app: string }) => (scope.app === 'boxlite' ? legacy : null),
      readCheckpoint: async () => native,
    },
    ownership: {
      inspect: async () => ({ phase, sourceDigests: { boxlite: digest } }),
      transition: async (request: any) => {
        await request.validate?.(signal)
        events.push(request.action)
        phase =
          ({ begin: 'adopting', cutover: 'native', rollback: 'legacy' } as Record<string, string>)[request.action] ??
          phase
      },
      run: async (scope: any, work: any) => {
        assert.equal(scope.action, 'migration')
        await work({ signal })
      },
    },
  }
  await writeStage({
    app,
    stage,
    clients: backend as any,
    values: {
      PULUMI_CONFIG_PASSPHRASE: 'fixture',
      AWS_PULUMI_MIGRATION: JSON.stringify({ boxlite: digest }),
      AWS_DATABASE_PASSWORD_SECRET_ARN: 'fixture-db',
      AWS_CACHE_PASSWORD_SECRET_ARN: 'fixture-cache',
      AWS_VOLUME_ACCESS_ROLE_NAME: 'fixture-volume',
    },
  })
  const environment = { MSTAGE_CONFIG: fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url)) }
  const cwd = fileURLToPath(new URL('../../', import.meta.url))
  const run = (action: string, ...args: string[]) =>
    migrateAws({
      cwd,
      argv: ['--stage', stage, '--action', action, ...args],
      environment,
      log: () => {},
      resolveHomeWith: async () =>
        ({
          backend,
          stateBucket: async () => 'stage-fixture',
          identity: { assertUsableFor: async () => {}, childEnvironment: async () => ({ env: {} }) },
        }) as any,
      createStackWith: async (options) => {
        assert.equal(options.backendUrl, 's3://stage-fixture')
        return {
          setAllConfig: async (config: any) => assert.ok(config['aws:region'].value),
          importStack: async (document: any) => {
            assert.equal(options.selectOnly, false)
            native = Buffer.from(JSON.stringify({ checkpoint: { latest: document.deployment } }))
            events.push('import')
          },
          refresh: async () => {
            events.push('refresh')
          },
          preview: async ({ onEvent }: any) => {
            events.push('preview')
            onEvent({ summaryEvent: {} })
          },
        } as any
      },
    })
  assert.equal(await run('status'), 0)
  await assert.rejects(run('begin', '--confirm'), /writers-settled/)
  await assert.rejects(run('unlock', '--confirm'), /writers-settled/)
  await assert.rejects(run('snapshot'), /requires --file/)
  const file = join(directory, 'backup.json')
  await run('snapshot', '--file', file)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).legacy.boxlite, legacy.toString('base64'))
  await assert.rejects(run('snapshot', '--file', file), /EEXIST/)
  await run('begin', '--writers-settled', '--confirm')
  await assert.rejects(run('import', '--confirm'), /requires --file/)
  const document = {
    version: 3,
    deployment: {
      resources: [
        {
          type: 'aws:rds/instance:Instance',
          urn: prefix + 'aws:rds/instance:Instance::Database',
          id: 'db-imported',
          custom: true,
        },
      ],
    },
  }
  const imported = join(directory, 'import.json')
  await writeFile(imported, JSON.stringify(document))
  await run('import', '--confirm', '--file', imported)
  await run('refresh', '--confirm')
  await run('preview')
  await run('cutover', '--confirm')
  await run('rollback', '--confirm')
  await run('unlock', '--writers-settled', '--confirm')
  assert.deepEqual(events, ['begin', 'import', 'refresh', 'preview', 'preview', 'cutover', 'rollback', 'unlock'])
})
