import { posix } from 'node:path';
import type { VolumeSpec } from '@microcloud/shared';
import type { EnvRow } from './db.js';
import { fail } from './errors.js';
import { controlHeaders } from './supervisor.js';

/** Same per-file limit as source uploads. */
export const VOLUME_FILE_MAX = 50 * 1024 * 1024;

/**
 * `uploads` + `/a/b.png` → `/data/uploads/a/b.png`. The path is taken relative to the mount; any
 * `..` that would leave it is refused here, and the supervisor checks again on its side.
 */
export function volumePath(volumes: readonly VolumeSpec[], name: string, path: string | undefined): { volume: VolumeSpec; rel: string; abs: string } {
  const volume = volumes.find((v) => v.name === name);
  if (!volume) {
    throw fail('not_found', `no volume "${name}" in the live spec`, volumes.length ? `volumes here: ${volumes.map((v) => v.name).join(', ')}` : 'add a [[volume]] to boxlite.toml and `boxlite-app apply --yes`');
  }
  const raw = (path ?? '/').replace(/\\/g, '/');
  if (raw.includes('\0')) throw fail('invalid_request', 'path must not contain NUL bytes');
  if (raw.split('/').includes('..')) throw fail('forbidden', 'path must stay inside the volume (no ..)', `\`boxlite-app app volume ls ${name}\``);
  const rel = posix.normalize(`/${raw}`).replace(/\/+$/, '') || '/';
  const abs = rel === '/' ? volume.mount : posix.join(volume.mount, rel);
  return { volume, rel, abs };
}

/**
 * `/.boxlite/sv/*` takes the control secret (`X-BoxLite-Control`) only; the gateway refuses control
 * calls that carry the forwarding secret (F3). Every env has a control secret (db migration 5). One
 * helper for all control calls lives in supervisor.ts; re-exported here for existing importers.
 */
export { controlHeaders } from './supervisor.js';

function gatewayUrl(env: EnvRow, abs: string, overwrite = false, recursive = false): string {
  const q = new URLSearchParams({ path: abs });
  if (overwrite) q.set('overwrite', '1');
  if (recursive) q.set('recursive', '1');
  return `${env.box_url}/.boxlite/sv/files?${q}`;
}

/** Maps the gateway's file errors to contract errors; an old supervisor answers a plain 404 `not_found`. */
async function gatewayError(res: Response, volume: string, rel: string, op: 'read' | 'write' | 'remove' = 'read'): Promise<never> {
  let code = '';
  let message = '';
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    code = body.error ?? '';
    message = body.message ?? '';
  } catch {
    // non-JSON: fall through to the generic error
  }
  if (code === 'no_such_file') throw fail('not_found', `${volume}:${rel} does not exist`, `\`boxlite-app app volume ls ${volume}:${posix.dirname(rel)}\` lists what is there`);
  if (code === 'exists') throw fail('conflict', `${volume}:${rel} already exists`, 'pass --force to replace it: `boxlite-app app volume cp <file> <volume>:<path> --force`');
  if (code === 'outside_volume') throw fail('forbidden', `${volume}:${rel} is outside the volume`, `\`boxlite-app app volume ls ${volume}\``);
  if (code === 'too_large') throw fail('invalid_request', message || 'file too large', `files are limited to ${VOLUME_FILE_MAX / 1024 / 1024} MB`);
  if (code === 'is_directory' && op === 'remove') throw fail('invalid_request', `${volume}:${rel} is a folder`, `delete it and everything in it: \`boxlite-app app volume rm ${volume}:${rel} --recursive\``);
  if (code === 'is_directory') throw fail('invalid_request', `${volume}:${rel} is a directory`, `\`boxlite-app app volume ls ${volume}:${rel}\``);
  if (code === 'is_volume') throw fail('invalid_request', `refusing to delete the volume ${volume} itself`, `name what is inside it: \`boxlite-app app volume ls ${volume}\``);
  // An older supervisor has no DELETE (405) or no file access at all (404).
  if (code === 'not_found' || res.status === 404 || res.status === 405) throw fail('not_supported_yet', 'this Box runs a supervisor without file access', 'the Box runs an older supervisor and updates it the next time the Box starts (it sleeps after 15 idle minutes and starts on the next request); retry after that');
  throw fail('unavailable', `the Box answered ${res.status}${message ? `: ${message}` : ''}`, 'rerun in 30 s; `boxlite-app doctor` checks the Box');
}

/** GET through the Box tunnel: a JSON listing for a directory, the bytes for a file. */
export async function readVolume(env: EnvRow, volume: string, rel: string, abs: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(gatewayUrl(env, abs), { headers: controlHeaders(env), signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw fail('unavailable', `cannot reach the Box: ${(err as Error).message}`, 'rerun in 30 s; the Box may be waking up');
  }
  if (!res.ok) return gatewayError(res, volume, rel);
  return res;
}

export async function writeVolume(env: EnvRow, volume: string, rel: string, abs: string, body: ArrayBuffer, overwrite: boolean): Promise<{ bytes: number; replaced: boolean }> {
  let res: Response;
  try {
    res = await fetch(gatewayUrl(env, abs, overwrite), {
      method: 'PUT',
      headers: { ...controlHeaders(env), 'content-type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw fail('unavailable', `cannot reach the Box: ${(err as Error).message}`, 'rerun in 30 s; the Box may be waking up');
  }
  if (!res.ok) return gatewayError(res, volume, rel, 'write');
  const out = (await res.json()) as { bytes?: number; replaced?: boolean };
  return { bytes: out.bytes ?? body.byteLength, replaced: out.replaced === true };
}

/** Deletes a file, or a folder with `recursive`; the supervisor refuses the volume itself. */
export async function removeVolume(env: EnvRow, volume: string, rel: string, abs: string, recursive: boolean): Promise<{ removed: 'file' | 'directory' }> {
  let res: Response;
  try {
    res = await fetch(gatewayUrl(env, abs, false, recursive), { method: 'DELETE', headers: controlHeaders(env), signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw fail('unavailable', `cannot reach the Box: ${(err as Error).message}`, 'rerun in 30 s; the Box may be waking up');
  }
  if (!res.ok) return gatewayError(res, volume, rel, 'remove');
  const out = (await res.json()) as { removed?: 'file' | 'directory' };
  return { removed: out.removed ?? 'file' };
}
