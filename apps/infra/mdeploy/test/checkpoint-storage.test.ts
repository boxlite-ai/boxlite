import assert from 'node:assert/strict'
import test from 'node:test'
import { gcpStorageProvider } from '../stack/providers/gcp/storage.ts'

const out = <T>(value: T): any => ({ value, apply: (render: (value: T) => unknown) => out(render(value)) })

test('GCS checkpoint storage uses its dedicated name and leaves application storage unchanged', () => {
  const buckets: { logicalName: string; args: Record<string, unknown> }[] = []
  const target = globalThis as Record<string, unknown>
  target.$app = { name: 'boxlite', stage: 'dev' }
  target.gcp = {
    storage: {
      Bucket: class {
        name: any
        url: any
        constructor(logicalName: string, args: Record<string, unknown>) {
          buckets.push({ logicalName, args })
          this.name = out(args.name)
          this.url = out(`gs://${args.name}`)
        }
      },
    },
    serviceaccount: {
      Account: class {
        email = out('volume-access@example.invalid')
      },
    },
  }

  const storage = gcpStorageProvider({ project: 'test-project', region: 'us-west1', appShort: 'bl-app' })({
    volumePrefix: 'boxlite-volume',
    versioning: true,
  })
  assert.deepEqual(
    buckets.map(({ logicalName, args }) => [logicalName, args.name]),
    [
      ['Storage', 'boxlite-dev-storage'],
      ['Checkpoints', 'boxlite-dev-checkpoints'],
    ],
  )
  assert.equal((storage.name as any).value, 'boxlite-dev-storage')
  assert.ok(storage.checkpoints.active)
  assert.equal((storage.checkpoints.bucket as any).value, 'boxlite-dev-checkpoints')
  assert.equal((storage.checkpoints.archivePrefix as any).value, 'gs://boxlite-dev-checkpoints/checkpoints/')

  const checkpoint = buckets.find(({ logicalName }) => logicalName === 'Checkpoints')!
  assert.equal(checkpoint.args.project, 'test-project')
  assert.equal(checkpoint.args.location, 'US-WEST1')
  assert.equal(checkpoint.args.uniformBucketLevelAccess, true)
  assert.equal(checkpoint.args.publicAccessPrevention, 'enforced')
  assert.deepEqual(checkpoint.args.softDeletePolicy, { retentionDurationSeconds: 0 })
  assert.equal('versioning' in checkpoint.args, false)
  assert.deepEqual(buckets[0].args.versioning, { enabled: true })
})
