import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { newId, type Vars } from '../auth.js';
import { SHA256_RE, snapshotId } from '../blobs.js';
import type { SnapshotFile } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from '../platform.js';
import { rateLimited, uploadSlot } from '../limits.js';
import { body } from './util.js';

const fileSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  mode: z.number().int().min(0).max(0o7777),
  sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase hex characters'),
});

/** Relative, normalised, no `..`, no absolute paths — the supervisor extracts these as-is. */
function pathProblem(p: string): string | null {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return 'must be a relative POSIX path';
  if (posix.normalize(p) !== p || p.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'must be normalised (no ./, ../ or //)';
  return null;
}

export function uploadRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  const { store, blobs } = ctx;

  const uploadOf = (appId: string, id: string) => {
    const row = store.get<{ id: string; manifest: string; snapshot_id: string | null }>('SELECT id, manifest, snapshot_id FROM uploads WHERE id = ? AND app_id = ?', id, appId);
    if (!row) throw fail('not_found', `no upload ${id}`, 'start a new upload');
    return { ...row, files: JSON.parse(row.manifest) as SnapshotFile[] };
  };

  r.post('/uploads', async (c) => {
    const app = c.get('app');
    const b = await body(c, z.object({ manifest: z.array(fileSchema).max(100_000) }));
    const errors: { file: string; rule: string; message: string }[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const f of b.manifest) {
      const problem = pathProblem(f.path);
      if (problem) errors.push({ file: f.path, rule: 'upload_path', message: `${f.path}: ${problem}` });
      if (seen.has(f.path)) errors.push({ file: f.path, rule: 'upload_duplicate', message: `${f.path} is listed twice` });
      seen.add(f.path);
      if (f.size > MAX_FILE_BYTES) errors.push({ file: f.path, rule: 'file_too_large', message: `${f.path} is ${f.size} bytes; files are limited to ${MAX_FILE_BYTES}` });
      total += f.size;
    }
    if (total > MAX_SNAPSHOT_BYTES) errors.push({ file: '.', rule: 'upload_too_large', message: `upload is ${total} bytes; the limit is ${MAX_SNAPSHOT_BYTES}` });
    if (errors.length) throw fail('invalid_manifest', `${errors.length} problem(s) in the upload manifest`, 'fix the files or add them to .boxliteignore', { errors });

    const id = newId('upl');
    store.run('INSERT INTO uploads (id, app_id, manifest, created_at) VALUES (?, ?, ?, ?)', id, app.id, JSON.stringify(b.manifest), now());
    const missing = [...new Set(b.manifest.map((f) => f.sha256))].filter((sha) => !blobs.has(app.id, sha));
    return c.json({ upload_id: id, missing });
  });

  r.put('/uploads/:id/files/:sha', async (c) => {
    const app = c.get('app');
    const up = uploadOf(app.id, c.req.param('id'));
    const sha = c.req.param('sha');
    const file = up.files.find((f) => f.sha256 === sha);
    if (!file) throw fail('not_found', `sha256 ${sha} is not part of upload ${up.id}`);
    const release = uploadSlot(ctx, app.id);
    if (!release) return rateLimited(c, 'too many file uploads in flight for this App', 1, 'upload fewer files at once, or wait {s} s and retry');
    try {
      const raw = c.req.raw.body;
      const stream = raw ? Readable.fromWeb(raw as import('node:stream/web').ReadableStream) : Readable.from([]);
      const out = await blobs.put(app.id, sha, stream, MAX_FILE_BYTES);
      return c.json({ sha256: sha, bytes: out.bytes, deduped: out.deduped });
    } finally {
      release();
    }
  });

  r.post('/uploads/:id/complete', (c) => {
    const app = c.get('app');
    const up = uploadOf(app.id, c.req.param('id'));
    const missing = [...new Set(up.files.map((f) => f.sha256))].filter((sha) => !blobs.has(app.id, sha));
    if (missing.length) throw fail('upload_incomplete', `${missing.length} file(s) not uploaded yet`, 'PUT the missing files, then complete again', { missing });
    const id = snapshotId(up.files);
    const bytes = up.files.reduce((n, f) => n + f.size, 0);
    store.run('INSERT OR IGNORE INTO snapshots (app_id, id, manifest, files, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)', app.id, id, JSON.stringify(up.files), up.files.length, bytes, now());
    store.run('UPDATE uploads SET snapshot_id = ? WHERE id = ?', id, up.id);
    return c.json({ snapshot_id: id, files: up.files.length, bytes });
  });

  return r;
}
