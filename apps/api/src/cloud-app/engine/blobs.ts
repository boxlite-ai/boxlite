import type { AppSourceStore } from './ctx'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import tarStream from 'tar-stream'
import type { SnapshotFile } from './db'

export const SHA256_RE = /^[a-f0-9]{64}$/

/** snap_<sha256 of the canonical manifest>: same files, same modes → same snapshot id. */
export function snapshotId(files: SnapshotFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, size: f.size, mode: f.mode, sha256: f.sha256 }))
  return 'snap_' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Streams a snapshot as tar.gz with the project root at the top level (contracts §2.2). */
export function snapshotTarGz(blobs: AppSourceStore, appId: string, files: SnapshotFile[]): Readable {
  const pack = tarStream.pack()
  const gz = createGzip()
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1))
  void (async () => {
    try {
      const dirs = new Set<string>()
      for (const f of sorted) {
        const parts = f.path.split('/')
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join('/')
          if (dirs.has(d)) continue
          dirs.add(d)
          await new Promise<void>((res, rej) =>
            pack.entry({ name: d + '/', type: 'directory', mode: 0o755 }, (err) => (err ? rej(err) : res())),
          )
        }
        const entry = pack.entry({ name: f.path, size: f.size, mode: f.mode & 0o7777 || 0o644, type: 'file' })
        await pipeline(blobs.read(appId, f.sha256), entry)
      }
      pack.finalize()
    } catch (err) {
      pack.destroy(err as Error)
    }
  })()
  pack.pipe(gz)
  pack.on('error', (err) => gz.destroy(err))
  return gz
}
