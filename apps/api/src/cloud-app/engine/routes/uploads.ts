import { filterAsync } from '../async'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  SOURCE_CREDENTIAL_HINT,
  sourceFileLabel,
  sourceSecretKindIn,
  type CheckError,
} from '@boxlite-ai/cloud-app-shared'
import { newId, type Vars } from '../auth'
import { SHA256_RE, snapshotId } from '../blobs'
import type { SnapshotFile } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { fail } from '../errors'
import { MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from '../platform'
import { rateLimited, uploadSlot } from '../limits'
import { body } from './util'

const fileSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  mode: z.number().int().min(0).max(0o7777),
  sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase hex characters'),
})

/** Relative, normalised, no `..`, no absolute paths — the supervisor extracts these as-is. */
function pathProblem(p: string): string | null {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return 'must be a relative POSIX path'
  if (posix.normalize(p) !== p || p.split('/').some((s) => s === '..' || s === '.' || s === ''))
    return 'must be normalised (no ./, ../ or //)'
  return null
}

function credentialPathProblems(files: SnapshotFile[]): CheckError[] {
  return files.flatMap(({ path, sha256 }) => {
    const kind = sourceSecretKindIn(path)
    return kind ? [{ file: sourceFileLabel(path, sha256), rule: 'secret_file', message: `Path contains ${kind}.` }] : []
  })
}

function requireSafePaths(files: SnapshotFile[]) {
  const errors = credentialPathProblems(files)
  if (errors.length)
    throw fail('invalid_manifest', 'A source path contains a credential', SOURCE_CREDENTIAL_HINT, { errors })
}

export function uploadRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>()
  const { store, blobs } = ctx

  const uploadOf = async (appId: string, id: string) => {
    const row = await store.get<{ id: string; manifest: string; snapshot_id: string | null }>(
      'SELECT id, manifest, snapshot_id FROM uploads WHERE id = ? AND app_id = ?',
      id,
      appId,
    )
    if (!row) throw fail('not_found', `no upload ${sourceFileLabel(id)}`, 'start a new upload')
    return { ...row, files: JSON.parse(row.manifest) as SnapshotFile[] }
  }

  r.post('/uploads', async (c) => {
    const app = c.get('app')
    const b = await body(c, z.object({ manifest: z.array(fileSchema).max(100_000) }))
    const errors = credentialPathProblems(b.manifest)
    const seen = new Set<string>()
    let total = 0
    for (const f of b.manifest) {
      const file = sourceFileLabel(f.path, f.sha256)
      const problem = pathProblem(f.path)
      if (problem) errors.push({ file, rule: 'upload_path', message: `${file}: ${problem}` })
      if (seen.has(f.path)) errors.push({ file, rule: 'upload_duplicate', message: `${file} is listed twice` })
      seen.add(f.path)
      if (f.size > MAX_FILE_BYTES)
        errors.push({
          file,
          rule: 'file_too_large',
          message: `${file} is ${f.size} bytes; files are limited to ${MAX_FILE_BYTES}`,
        })
      total += f.size
    }
    if (total > MAX_SNAPSHOT_BYTES)
      errors.push({
        file: '.',
        rule: 'upload_too_large',
        message: `upload is ${total} bytes; the limit is ${MAX_SNAPSHOT_BYTES}`,
      })
    if (errors.length)
      throw fail(
        'invalid_manifest',
        `${errors.length} problem(s) in the upload manifest`,
        errors.some((error) => error.rule === 'secret_file')
          ? SOURCE_CREDENTIAL_HINT
          : 'fix the files or add them to .boxliteignore',
        { errors },
      )

    const missing = await filterAsync(
      [...new Set(b.manifest.map((f) => f.sha256))],
      async (sha) => !(await blobs.hasScanned(app.id, sha)),
    )
    const id = newId('upl')
    await store.run(
      'INSERT INTO uploads (id, app_id, manifest, created_at) VALUES (?, ?, ?, ?)',
      id,
      app.id,
      JSON.stringify(b.manifest),
      now(),
    )
    return c.json({ upload_id: id, missing })
  })

  r.put('/uploads/:id/files/:sha', async (c) => {
    const app = c.get('app')
    const up = await uploadOf(app.id, c.req.param('id'))
    const sha = c.req.param('sha')
    const files = up.files.filter((f) => f.sha256 === sha)
    const [file] = files
    if (!file) throw fail('not_found', `sha256 ${sourceFileLabel(sha)} is not part of upload ${up.id}`)
    requireSafePaths(files)
    const release = uploadSlot(ctx, app.id)
    if (!release)
      return rateLimited(
        c,
        'too many file uploads in flight for this App',
        1,
        'upload fewer files at once, or wait {s} s and retry',
      )
    try {
      const raw = c.req.raw.body
      const stream = raw ? Readable.fromWeb(raw as import('node:stream/web').ReadableStream) : Readable.from([])
      const out = await blobs.put(app.id, sha, stream, MAX_FILE_BYTES, file.path)
      return c.json({ sha256: sha, bytes: out.bytes, deduped: out.deduped })
    } finally {
      release()
    }
  })

  r.post('/uploads/:id/complete', async (c) => {
    const app = c.get('app')
    const up = await uploadOf(app.id, c.req.param('id'))
    requireSafePaths(up.files)
    const missing = await filterAsync(
      [...new Set(up.files.map((f) => f.sha256))],
      async (sha) => !(await blobs.hasScanned(app.id, sha)),
    )
    if (missing.length)
      throw fail(
        'upload_incomplete',
        `${missing.length} file(s) not uploaded yet`,
        'rerun `boxlite-app deploy` for a fresh upload, or PUT the missing files and complete again',
        { missing },
      )
    const id = snapshotId(up.files)
    const bytes = up.files.reduce((n, f) => n + f.size, 0)
    await store.run(
      'INSERT OR IGNORE INTO snapshots (app_id, id, manifest, files, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      app.id,
      id,
      JSON.stringify(up.files),
      up.files.length,
      bytes,
      now(),
    )
    await store.run('UPDATE uploads SET snapshot_id = ? WHERE id = ?', id, up.id)
    return c.json({ snapshot_id: id, files: up.files.length, bytes })
  })

  return r
}
