import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tarStream from 'tar-stream';
import { fail } from './errors.js';
import type { SnapshotFile, Store } from './db.js';

export const SHA256_RE = /^[a-f0-9]{64}$/;

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Content-addressed file store, one namespace per App: DATA_DIR/blobs/<app_id>/<sha256>.
 *
 * Dedupe never crosses Apps. "Is this hash already here?" is answered from the App's own
 * directory only, so an upload's `missing` list says nothing about other tenants, and a
 * snapshot can only ever reference bytes its own App uploaded.
 */
export class BlobStore {
  readonly dir: string;
  private readonly tmp: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'blobs');
    this.tmp = join(dataDir, 'tmp');
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.tmp, { recursive: true });
  }

  private appDir(appId: string): string {
    if (!APP_ID_RE.test(appId)) throw fail('not_found', `bad app id ${appId}`);
    return join(this.dir, appId);
  }

  path(appId: string, sha: string): string {
    if (!SHA256_RE.test(sha)) throw fail('not_found', `bad blob id ${sha}`);
    return join(this.appDir(appId), sha);
  }

  has(appId: string, sha: string): boolean {
    return SHA256_RE.test(sha) && APP_ID_RE.test(appId) && existsSync(join(this.dir, appId, sha));
  }

  /**
   * Streams `body` to a temp file while hashing it, then renames it into place only if the
   * sha256 matches. A partially written or corrupt upload never becomes visible.
   */
  async put(appId: string, sha: string, body: Readable, maxBytes: number): Promise<{ bytes: number; deduped: boolean }> {
    if (!SHA256_RE.test(sha)) throw fail('checksum_mismatch', `"${sha}" is not a sha256 hex digest`);
    const dest = this.path(appId, sha);
    if (this.has(appId, sha)) {
      body.resume();
      return { bytes: 0, deduped: true };
    }
    const tmpPath = join(this.tmp, `${sha}.${randomBytes(6).toString('hex')}`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw fail('invalid_manifest', `file ${sha} is larger than ${maxBytes} bytes`);
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmpPath),
      );
      const got = hash.digest('hex');
      if (got !== sha) throw fail('checksum_mismatch', `uploaded bytes hash to ${got}, not ${sha}`, 're-read the file and upload it again');
      mkdirSync(this.appDir(appId), { recursive: true });
      renameSync(tmpPath, dest);
      return { bytes, deduped: false };
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  read(appId: string, sha: string): Readable {
    return createReadStream(this.path(appId, sha));
  }

  /**
   * One-time move from the old global layout (DATA_DIR/blobs/<sha>): every blob an App's
   * snapshots or uploads reference is copied into that App's directory. Idempotent: existing
   * per-App copies are kept, and a marker records that the pass completed. Legacy files are left
   * in place (nothing reads them any more).
   */
  migrateLegacy(refs: Iterable<{ appId: string; sha256: string }>): { copied: number } {
    const marker = join(this.dir, '.per-app-v1');
    if (existsSync(marker)) return { copied: 0 };
    let copied = 0;
    for (const { appId, sha256 } of refs) {
      if (!SHA256_RE.test(sha256) || !APP_ID_RE.test(appId)) continue;
      const legacy = join(this.dir, sha256);
      if (!existsSync(legacy) || this.has(appId, sha256)) continue;
      mkdirSync(this.appDir(appId), { recursive: true });
      const tmpPath = join(this.tmp, `${sha256}.${randomBytes(6).toString('hex')}`);
      copyFileSync(legacy, tmpPath, constants.COPYFILE_FICLONE);
      renameSync(tmpPath, this.path(appId, sha256));
      copied++;
    }
    writeFileSync(marker, new Date().toISOString() + '\n');
    return { copied };
  }
}

/** Every (app, blob) the CP's state references: snapshot manifests and unfinished uploads. */
export function* blobRefs(store: Pick<Store, 'all'>): Generator<{ appId: string; sha256: string }> {
  for (const table of ['snapshots', 'uploads']) {
    for (const row of store.all<{ app_id: string; manifest: string }>(`SELECT app_id, manifest FROM ${table}`)) {
      let files: SnapshotFile[];
      try {
        files = JSON.parse(row.manifest) as SnapshotFile[];
      } catch {
        continue;
      }
      for (const f of files) yield { appId: row.app_id, sha256: f.sha256 };
    }
  }
}

/** Run once at start-up (buildCtx). */
export function migrateLegacyBlobs(ctx: { store: Pick<Store, 'all'>; blobs: BlobStore }): void {
  const { copied } = ctx.blobs.migrateLegacy(blobRefs(ctx.store));
  if (copied) console.log(`[blobs] copied ${copied} blob(s) into per-app directories`);
}

/** snap_<sha256 of the canonical manifest>: same files, same modes → same snapshot id. */
export function snapshotId(files: SnapshotFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, size: f.size, mode: f.mode, sha256: f.sha256 }));
  return 'snap_' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Streams a snapshot as tar.gz with the project root at the top level (contracts §2.2). */
export function snapshotTarGz(blobs: BlobStore, appId: string, files: SnapshotFile[]): Readable {
  const pack = tarStream.pack();
  const gz = createGzip();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  void (async () => {
    try {
      const dirs = new Set<string>();
      for (const f of sorted) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (dirs.has(d)) continue;
          dirs.add(d);
          await new Promise<void>((res, rej) => pack.entry({ name: d + '/', type: 'directory', mode: 0o755 }, (err) => (err ? rej(err) : res())));
        }
        const entry = pack.entry({ name: f.path, size: f.size, mode: f.mode & 0o7777 || 0o644, type: 'file' });
        await pipeline(blobs.read(appId, f.sha256), entry);
      }
      pack.finalize();
    } catch (err) {
      pack.destroy(err as Error);
    }
  })();
  pack.pipe(gz);
  pack.on('error', (err) => gz.destroy(err));
  return gz;
}
