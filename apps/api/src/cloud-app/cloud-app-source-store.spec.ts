import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Storage } from '@google-cloud/storage'
import { CloudAppSourceStore } from './cloud-app-source-store'
import { TypedConfigService } from '../config/typed-config.service'

jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }))

describe('Cloud App shared source storage', () => {
  const settings = { sourceBackend: 'gcs', sourceBucket: 'test-bucket', sourcePrefix: 'cloud-apps' }
  const configuration = {
    get: (name: string) => (name === 'cloudApps' ? settings : name === 's3' ? { region: 'test' } : undefined),
  }
  const objects = new Map<string, Buffer>()
  const save = jest.fn()
  beforeEach(() => {
    objects.clear()
    save.mockReset()
    ;(Storage as unknown as jest.Mock).mockImplementation(() => ({
      bucket: () => ({
        file: (key: string) => ({
          exists: async () => [objects.has(key)],
          save: async (bytes: Buffer) => {
            save(key)
            objects.set(key, bytes)
          },
          createReadStream: () => Readable.from([objects.get(key)!]),
        }),
        deleteFiles: async ({ prefix }: { prefix: string }) => {
          for (const key of objects.keys()) if (key.startsWith(prefix)) objects.delete(key)
        },
      }),
    }))
  })
  const store = () => new CloudAppSourceStore(configuration as unknown as TypedConfigService)

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
})
