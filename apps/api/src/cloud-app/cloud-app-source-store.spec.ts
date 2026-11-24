import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Storage } from '@google-cloud/storage'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Hono } from 'hono'
import { CloudAppSourceStore } from './cloud-app-source-store'
import { generateApiKeyValue } from '../common/utils/api-key'
import { TypedConfigService } from '../config/typed-config.service'
import { newBoxToken, type Vars } from './engine/auth'
import type { Ctx } from './engine/ctx'
import type { AppRow, SnapshotFile } from './engine/db'
import { HttpError } from './engine/errors'
import { uploadRoutes } from './engine/routes/uploads'

jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }))
jest.mock('@aws-sdk/client-s3', () => ({ ...jest.requireActual('@aws-sdk/client-s3'), S3Client: jest.fn() }))

describe.each(['gcs', 's3'])('Cloud App shared source storage (%s)', (sourceBackend) => {
  const settings = { sourceBackend, sourceBucket: 'test-bucket', sourcePrefix: 'cloud-apps' }
  const configuration = {
    get: (name: string) => (name === 'cloudApps' ? settings : name === 's3' ? { region: 'test' } : undefined),
  }
  const objects = new Map<string, Buffer>()
  const metadata = new Map<string, Record<string, unknown>>()
  const save = jest.fn()
  const lookup = jest.fn()
  const keyFor = (sha: string) => `cloud-apps/app_one/${sha}`
  function remember(key: string, bytes: Buffer, marker: Record<string, unknown> = {}) {
    save(key)
    objects.set(key, bytes)
    metadata.set(key, marker)
  }
  beforeEach(() => {
    objects.clear()
    metadata.clear()
    save.mockReset()
    lookup.mockReset()
    ;(Storage as unknown as jest.Mock).mockImplementation(() => ({
      bucket: () => ({
        file: (key: string) => ({
          exists: async () => [objects.has(key)],
          getMetadata: async () => {
            lookup()
            if (!objects.has(key)) throw Object.assign(new Error('missing'), { code: 404 })
            return [{ metadata: metadata.get(key) }]
          },
          save: async (bytes: Buffer, options: { metadata?: { metadata?: Record<string, unknown> } }) =>
            remember(key, bytes, options.metadata?.metadata),
          createReadStream: () => Readable.from([objects.get(key)!]),
        }),
        deleteFiles: async ({ prefix }: { prefix: string }) => {
          for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key)
        },
      }),
    }))
    ;(S3Client as unknown as jest.Mock).mockImplementation(() => ({
      send: async (
        command: HeadObjectCommand | GetObjectCommand | PutObjectCommand | ListObjectsV2Command | DeleteObjectsCommand,
      ) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [...objects.keys()]
              .filter((key) => key.startsWith(command.input.Prefix!))
              .map((Key) => ({ Key })),
          }
        }
        if (command instanceof DeleteObjectsCommand) {
          for (const { Key } of command.input.Delete!.Objects!) objects.delete(Key!)
          return {}
        }
        const key = command.input.Key!
        if (command instanceof PutObjectCommand)
          return remember(key, command.input.Body as Buffer, command.input.Metadata)
        if (command instanceof GetObjectCommand) return { Body: Readable.from([objects.get(key)!]) }
        lookup()
        if (!objects.has(key)) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } })
        return { Metadata: metadata.get(key) }
      },
    }))
  })
  const store = () => new CloudAppSourceStore(configuration as unknown as TypedConfigService)

  function apiFor(source: CloudAppSourceStore, files: SnapshotFile[]) {
    const run = jest.fn().mockResolvedValue(undefined)
    const ctx = {
      blobs: source,
      store: { run, get: async () => ({ id: 'legacy', manifest: JSON.stringify(files), snapshot_id: null }) },
    } as unknown as Ctx
    const api = new Hono<{ Variables: Vars }>()
    api.use('*', async (c, next) => {
      c.set('app', { id: 'app_one' } as AppRow)
      await next()
    })
    api.route('/', uploadRoutes(ctx))
    api.onError((error, c) => {
      if (error instanceof HttpError) return c.json(error.toBody(), error.status as 422)
      throw error
    })
    return { api, run }
  }

  const snapshotFile = (path: string, content: string): SnapshotFile => ({
    path,
    size: Buffer.byteLength(content),
    mode: 0o644,
    sha256: createHash('sha256').update(content).digest('hex'),
  })

  const start = (api: ReturnType<typeof apiFor>['api'], ...files: SnapshotFile[]) =>
    api.request('/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: files }),
    })

  it('reads source uploaded by another API replica and scopes cleanup to its App', async () => {
    const bytes = Buffer.from('export default "deployed"')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const first = store(),
      second = store()
    await first.put('app_one', sha, Readable.from([bytes]), 1000)
    await first.put('app_two', sha, Readable.from([bytes]), 1000)
    const chunks: Buffer[] = []
    for await (const chunk of second.read('app_one', sha)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(bytes)
    await expect(second.put('app_one', sha, Readable.from([bytes]), 1000)).resolves.toEqual({ bytes: 0, deduped: true })
    expect(save).toHaveBeenCalledTimes(2)
    await second.deleteApp('app_one')
    expect(await first.has('app_one', sha)).toBe(false)
    expect(await first.has('app_two', sha)).toBe(true)
  })

  it('does not persist oversized or mismatched source content', async () => {
    const bytes = Buffer.from('unexpected')
    const source = store()
    await expect(source.put('app_one', '0'.repeat(64), Readable.from([bytes]), 1000)).rejects.toThrow('manifest')
    await expect(source.put('app_one', '0'.repeat(64), Readable.from([bytes]), 2)).rejects.toThrow('exceeds')
    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'GitHub token', fixture: () => `ghp_${'Qa1'.repeat(12)}` },
    { kind: 'BoxLite supervisor token', fixture: newBoxToken },
    ...(['live', 'test', 'svc'] as const).flatMap((keyClass) =>
      ['a0', 'a1b2c3d4e5f6g7h8'].map((brand) => ({
        kind: 'BoxLite platform key',
        fixture: () => generateApiKeyValue(brand, keyClass),
      })),
    ),
  ])('rejects a matching, in-limit PUT with a $kind before a write ($#)', async ({ kind, fixture }) => {
    const token = fixture()
    const content = `token=${token}`
    const file = snapshotFile('config.txt', content)
    const { api, run } = apiFor(store(), [file])
    const rejected = await api.request(`/uploads/legacy/files/${file.sha256}`, { method: 'PUT', body: content })
    const diagnostic = await rejected.text()
    expect(rejected.status).toBe(422)
    expect(diagnostic.includes(token)).toBe(false)
    expect(JSON.parse(diagnostic).error.errors[0]).toMatchObject({ rule: 'secret_file', file: file.path })
    expect(diagnostic.includes(kind)).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(objects.has(keyFor(file.sha256))).toBe(false)
    expect((await (await api.request('/uploads/legacy/complete', { method: 'POST' })).json()).error.code).toBe(
      'upload_incomplete',
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['start', 'invalid start', 'PUT', 'complete'])(
    'rejects a credential-shaped path at %s with clean bytes',
    async (operation) => {
      const token = newBoxToken()
      const content = 'plain text'
      const file = snapshotFile(`${operation === 'invalid start' ? '../' : ''}config/${token}.txt`, content)
      const source = store()
      await source.put('app_one', file.sha256, Readable.from([content]), 1000)
      save.mockClear()
      const { api, run } = apiFor(source, [file])
      const response = operation.endsWith('start')
        ? await start(api, ...(operation === 'start' ? [file] : [file, file]))
        : operation === 'PUT'
          ? await api.request(`/uploads/legacy/files/${file.sha256}`, { method: 'PUT', body: content })
          : await api.request('/uploads/legacy/complete', { method: 'POST' })
      const diagnostic = await response.text()
      expect(response.status).toBe(422)
      expect(diagnostic.includes(token)).toBe(false)
      const errors = JSON.parse(diagnostic).error.errors
      expect(errors[0]).toMatchObject({
        rule: 'secret_file',
        file: expect.stringContaining(file.sha256),
      })
      if (operation === 'start') expect(errors).toHaveLength(1)
      if (operation === 'invalid start')
        expect(errors.map(({ rule }: { rule: string }) => rule)).toEqual(
          expect.arrayContaining(['upload_path', 'upload_duplicate']),
        )
      expect(save).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    },
  )

  it.each(['absent', 'stale'])(
    'requests a digest when the marker is %s and deduplicates after reupload',
    async (marker) => {
      const content = 'clean legacy bytes'
      const file = snapshotFile('config.txt', content)
      objects.set(keyFor(file.sha256), Buffer.from(content))
      if (marker === 'stale') metadata.set(keyFor(file.sha256), { 'boxlite-source-scan-version': '0' })
      const first = store()
      expect(await first.has('app_one', file.sha256)).toBe(true)
      const chunks: Buffer[] = []
      for await (const chunk of first.read('app_one', file.sha256)) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe(content)
      const { api } = apiFor(first, [file])
      const incomplete = await (await api.request('/uploads/legacy/complete', { method: 'POST' })).json()
      expect(incomplete).toMatchObject({ error: { code: 'upload_incomplete' } })
      expect(incomplete.error.next).toContain('boxlite-app deploy')
      expect(await (await start(api, file)).json()).toMatchObject({ missing: [file.sha256] })
      expect(await first.put('app_one', file.sha256, Readable.from([content]), 1000)).toEqual({
        bytes: file.size,
        deduped: false,
      })
      const second = store()
      const retry = apiFor(second, [file]).api
      expect(await (await start(retry, file)).json()).toMatchObject({ missing: [] })
      expect((await retry.request('/uploads/legacy/complete', { method: 'POST' })).status).toBe(200)
      expect(save).toHaveBeenCalledTimes(1)
    },
  )

  it('propagates storage lookup errors without admitting the digest or writing source', async () => {
    const denied = Object.assign(new Error('Access denied'), { code: 403, $metadata: { httpStatusCode: 403 } })
    lookup.mockImplementation(() => {
      throw denied
    })
    const source = store()
    const file = snapshotFile('config.txt', 'clean bytes')
    const { api, run } = apiFor(source, [file])
    await expect(start(api, file)).rejects.toBe(denied)
    await expect(api.request('/uploads/legacy/complete', { method: 'POST' })).rejects.toBe(denied)
    await expect(source.put('app_one', file.sha256, Readable.from(['clean bytes']), 1000)).rejects.toBe(denied)
    expect(run).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
