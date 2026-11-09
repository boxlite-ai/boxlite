import assert from 'node:assert/strict'
import test from 'node:test'
import { promotionSourcesFor, bootstrapGcp, type Run } from './gcp.ts'

const config = {
  app: 'boxlite-app',
  path: '/repo/.mstage.config.json',
  stages: {
    dev: { project: 'shared' },
    stage: { project: 'shared' },
    prod: { project: 'production', promoteFrom: ['dev', 'stage'] },
  },
}

test('bootstrap resolves both sources in a shared project without losing either bucket', () => {
  let sources: ReturnType<typeof promotionSourcesFor> = []
  assert.doesNotThrow(() => {
    sources = promotionSourcesFor({ config, stage: 'prod' })
  }, 'both declared promotion sources must resolve')
  assert.deepEqual(sources, [
    { stage: 'dev', project: 'shared', bucket: 'boxlite-app-dev-artifacts-shared' },
    { stage: 'stage', project: 'shared', bucket: 'boxlite-app-stage-artifacts-shared' },
  ])
  assert.deepEqual(promotionSourcesFor({ config, stage: 'stage' }), [])
  assert.throws(
    () => promotionSourcesFor({ config: { ...config, stages: { prod: config.stages.prod } }, stage: 'prod' }),
    /declares no such stage/,
  )
})

test('bootstrap grants the registry once per project and object reads on every source bucket', async () => {
  const calls: string[][] = []
  const run: Run = async (_command, args) => {
    calls.push(args)
    if (args.slice(0, 2).join(' ') === 'projects describe') return { code: 0, stdout: '123456789012', stderr: '' }
    if (args.slice(0, 3).join(' ') === 'secrets versions access')
      return {
        code: 0,
        stdout: args.includes('mstage-bootstrap') ? '{"state":"test-state"}' : 'test-only-passphrase',
        stderr: '',
      }
    return { code: 0, stdout: '{}', stderr: '' }
  }
  await bootstrapGcp({
    run,
    project: 'production',
    region: 'us-east5',
    app: 'boxlite-app',
    appShort: 'bl-app',
    stage: 'prod',
    repository: 'images',
    immutableTags: true,
    github: {
      issuer: 'https://token.actions.githubusercontent.com',
      owner: 'example',
      ownerId: '1',
      repository: 'test',
      repositoryId: '2',
    },
    promotionSources: [
      { stage: 'dev', project: 'shared', bucket: 'boxlite-app-dev-artifacts-shared' },
      { stage: 'stage', project: 'shared', bucket: 'boxlite-app-stage-artifacts-shared' },
    ],
    log: () => {},
    wait: async () => {},
  })
  const reads = calls.filter((args) => args.includes('--project') && args[args.indexOf('--project') + 1] === 'shared')
  assert.equal(
    reads.filter((args) => args.includes('--role=roles/artifactregistry.reader')).length,
    1,
    'shared project must grant registry access once',
  )
  const buckets = reads.filter((args) => args.includes('--role=roles/storage.objectViewer'))
  assert.deepEqual(buckets.map((args) => args[3]).sort(), [
    'gs://boxlite-app-dev-artifacts-shared',
    'gs://boxlite-app-stage-artifacts-shared',
  ])
  for (const args of buckets) {
    assert.ok(args.includes('--member=serviceAccount:bl-app-prod-deploy@production.iam.gserviceaccount.com'))
    assert.ok(args.includes('--condition=None'))
  }
})
