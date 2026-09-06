/*
 * The GCP backend, against a fake Storage and Secret Manager.
 *
 * The bucket lookup is what most of this checks. It exists so that moving the
 * store is one edit to one record, and a lookup that quietly falls back to a
 * hard-coded name would give that up without anyone noticing — the store would
 * keep working, against the wrong bucket.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { EnvError, objectKey, seal } from '../src/env/backend.ts'
import { gcpBackend, readStateBucket, type GcpClients } from '../src/env/gcp-backend.ts'
import { readEnvironment, setValues } from '../src/env/store.ts'

const KEY = randomBytes(32)
const PROJECT = 'boxlite-dev'
const BUCKET = 'mstage-state-boxlite-dev'

const notFound = (code: number) => Object.assign(new Error('not found'), { code })

const google = ({
  bootstrap = JSON.stringify({ state: BUCKET }),
  passphrase = KEY.toString('base64'),
  objects = new Map<string, { data: Buffer; generation: number }[]>(),
}: {
  bootstrap?: string | Error
  passphrase?: string | Error
  objects?: Map<string, { data: Buffer; generation: number }[]>
} = {}) => {
  const reads: string[] = []
  let generation = 0
  const clients: GcpClients = {
    storage: {
      bucket: (name) => {
        reads.push(`bucket:${name}`)
        return {
          file: (path, options) => ({
            async download() {
              reads.push(`get:${name}/${path}${options?.generation ? `@${options.generation}` : ''}`)
              const history = objects.get(path) ?? []
              if (history.length === 0) throw notFound(404)
              if (options?.generation === undefined) return [history.at(-1)!.data] as [Buffer]
              const found = history.find((entry) => entry.generation === options.generation)
              if (!found) throw notFound(404)
              return [found.data] as [Buffer]
            },
            async save(data) {
              reads.push(`put:${name}/${path}`)
              const history = objects.get(path) ?? []
              history.push({ data, generation: ++generation })
              objects.set(path, history)
            },
            async getMetadata() {
              const history = objects.get(path) ?? []
              if (history.length === 0) throw notFound(404)
              return [{ generation: history.at(-1)!.generation }] as [{ generation: number }]
            },
          }),
          async getFiles({ prefix }) {
            return [
              (objects.get(prefix) ?? []).map((entry) => ({
                name: prefix,
                metadata: { generation: entry.generation, size: entry.data.length, updated: '2026-01-01T00:00:00Z' },
              })),
            ] as [{ name: string; metadata: Record<string, unknown> }[]]
          },
        }
      },
    },
    secrets: {
      async accessSecretVersion({ name }) {
        reads.push(`secret:${name}`)
        const value = name.includes('mstage-bootstrap') ? bootstrap : passphrase
        if (value instanceof Error) throw value
        return [{ payload: { data: value } }] as [{ payload: { data: string } }]
      },
    },
  }
  return { clients, reads, objects, backend: gcpBackend({ clients, project: PROJECT }) }
}

const store = { app: 'a', stage: 'dev' }

test('the bucket is looked up, never assumed', async () => {
  const probe = google()
  assert.equal(await readStateBucket(probe.clients, PROJECT), BUCKET)
  assert.deepEqual(probe.reads, [`secret:projects/${PROJECT}/secrets/mstage-bootstrap/versions/latest`])
})

test('pointing the record at another bucket moves the store, and nothing else changes', async () => {
  // The whole reason for the lookup: one edit, in one place.
  const moved = google({ bootstrap: JSON.stringify({ state: 'somewhere-else' }) })
  await setValues({ clients: moved.backend, ...store, entries: [['A', '1']] })
  assert.ok(moved.reads.includes('bucket:somewhere-else'))
  assert.equal(moved.reads.some((read) => read.startsWith(`bucket:${BUCKET}`)), false)
})

test('a bootstrap record that names no bucket is refused', async () => {
  await assert.rejects(
    () => readStateBucket(google({ bootstrap: JSON.stringify({ version: 1 }) }).clients, PROJECT),
    /names no state bucket/,
  )
  await assert.rejects(() => readStateBucket(google({ bootstrap: 'not json' }).clients, PROJECT), /not valid JSON/)
  await assert.rejects(() => readStateBucket(google({ bootstrap: notFound(5) }).clients, PROJECT), /does not exist/)
})

test('a written stage reads back through the lookup', async () => {
  const probe = google()
  await setValues({ clients: probe.backend, ...store, entries: [['SMTP_USER', 'alice']] })
  assert.deepEqual(await readEnvironment({ clients: probe.backend, ...store }), { SMTP_USER: 'alice' })
  assert.ok(probe.reads.includes(`put:${BUCKET}/${objectKey('a', 'dev')}`), probe.reads.join(' '))
})

test('a stage nobody wrote is empty; a pinned generation that is gone is not', async () => {
  const probe = google()
  assert.deepEqual(await readEnvironment({ clients: probe.backend, ...store }), {})
  await assert.rejects(
    () => readEnvironment({ clients: probe.backend, ...store, versionId: '999' }),
    /has no version 999/,
  )
})

test('a version that is not a generation is refused before any call', async () => {
  // GCS generations are integers; an S3-shaped version id would otherwise be
  // sent as NaN and answered with the current object.
  const probe = google()
  await assert.rejects(
    () => readEnvironment({ clients: probe.backend, ...store, versionId: 'hb86RRZQ1eeCnZ' }),
    /is not a GCS generation/,
  )
  assert.equal(probe.reads.some((read) => read.startsWith('get:')), false)
})

test('a pinned generation reads what it named', async () => {
  const probe = google()
  await setValues({ clients: probe.backend, ...store, entries: [['A', 'first']] })
  const pinned = await probe.backend.currentVersion(store)
  await setValues({ clients: probe.backend, ...store, entries: [['A', 'second']] })

  assert.deepEqual(await readEnvironment({ clients: probe.backend, ...store }), { A: 'second' })
  assert.deepEqual(await readEnvironment({ clients: probe.backend, ...store, versionId: pinned! }), { A: 'first' })
})

test('a missing passphrase says which secret, not which bucket', async () => {
  const probe = google({ passphrase: notFound(5) })
  await probe.backend.write({ ...store, sealed: seal('{"A":"1"}', KEY, 'x') })
  await assert.rejects(() => readEnvironment({ clients: probe.backend, ...store }), EnvError)
  await assert.rejects(
    () => readEnvironment({ clients: probe.backend, ...store }),
    /mstage-passphrase-a-dev\/versions\/latest does not exist/,
  )
})

test('an object sealed on AWS opens here, because the key format is shared', async () => {
  // Moving a stage between clouds is a copy of bytes. The AWS backend seals
  // with the same passphrase encoding and the same nonce ‖ ciphertext ‖ tag.
  const probe = google()
  await probe.backend.write({ ...store, sealed: seal('{"A":"1"}', KEY, objectKey('a', 'dev')) })
  assert.deepEqual(await readEnvironment({ clients: probe.backend, ...store }), { A: '1' })
})
