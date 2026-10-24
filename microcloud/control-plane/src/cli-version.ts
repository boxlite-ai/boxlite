import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tarStream from 'tar-stream';

export interface CliPackage {
  version: string;
  sha256: string;
  bytes: number;
  updated_at: string;
}

let cache: { path: string; mtimeMs: number; value: CliPackage } | null = null;

/** `package/package.json` → version, read straight from the npm tarball the CP serves. */
async function versionInTarball(path: string): Promise<string | null> {
  const extract = tarStream.extract();
  let version: string | null = null;
  extract.on('entry', (header, stream, next) => {
    if (header.name.replace(/^\.\//, '') !== 'package/package.json') {
      stream.on('end', next);
      stream.resume();
      return;
    }
    const chunks: Buffer[] = [];
    stream.on('data', (c: unknown) => chunks.push(c as Buffer));
    stream.on('end', () => {
      try {
        const v = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { version?: unknown }).version;
        if (typeof v === 'string') version = v;
      } catch {
        // a broken package.json leaves the version unknown
      }
      next();
    });
  });
  await pipeline(createReadStream(path), createGunzip(), extract);
  return version;
}

/**
 * The CLI package this control plane hands out at /cli/boxlite-app.tgz, or null when there is none.
 * Cached by mtime: redeploying a new tarball is picked up without a restart.
 */
export async function cliPackage(path: string): Promise<CliPackage | null> {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs) return cache.value;
  const version = await versionInTarball(path).catch(() => null);
  if (!version) return null;
  const value: CliPackage = { version, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes: st.size, updated_at: st.mtime.toISOString() };
  cache = { path, mtimeMs: st.mtimeMs, value };
  return value;
}
