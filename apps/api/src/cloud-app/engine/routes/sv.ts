import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireBoxToken, type Vars } from '../auth'
import { snapshotTarGz } from '../blobs'
import type { Deployment, EnvRow, LogLine } from '../db'
import type { Ctx } from '../ctx'
import { fail, HttpError } from '../errors'
import { admitLogs } from '../limits'
import { recordLogs } from '../logsink'
import { volumeKey } from '../resources/volumes'
import type { SupervisorStatus } from '../supervisor'
import { body } from './util'

const logSchema = z
  .array(
    z.object({
      ts: z.string().optional(),
      source: z.string().max(64).default('system'),
      level: z.string().max(16).default('info'),
      line: z.string(),
      deployment: z.number().int().nullable().optional(),
    }),
  )
  .max(5000)

const statusSchema = z.object({
  deployment: z.number().int(),
  operation: z.number().int().positive().optional(),
  spec_version: z.number().int().positive().optional(),
  phase: z.enum(['building', 'built', 'starting', 'live', 'failed']),
  step: z.string().optional(),
  error: z.string().optional(),
  log_tail: z.array(z.string()).nullable().optional(),
  // Go encodes an empty slice as null.
  services: z
    .array(z.object({ name: z.string(), state: z.string() }).passthrough())
    .nullable()
    .optional(),
})

const recoverySchema = z.object({
  operation: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  box: z.string().min(1).max(128),
})

const LEGACY_SPEC_PENDING = 'legacy_spec_pending'

function legacySpecPending(): HttpError {
  return new HttpError(409, LEGACY_SPEC_PENDING, 'waiting for this deployment to be authorized to start')
}

function isLegacySpecPending(error: string | undefined): boolean {
  const response = /^GET (?:\/[^/\s:]+)*\/sv\/v1\/spec: HTTP 409: (.+)$/s.exec(error ?? '')?.[1]
  if (!response) return false
  try {
    return JSON.parse(response)?.error?.code === LEGACY_SPEC_PENDING
  } catch {
    return false
  }
}

/** The release dir a deployment runs from: its own for deploy, the target's for rollback, the live one for apply. */
async function releaseOf(ctx: Ctx, env: EnvRow, d: Deployment): Promise<number | null> {
  if (d.kind === 'deploy') return d.number
  if (d.release) return d.release
  if (d.kind === 'rollback') return (await ctx.store.deployment(env.id, d.request.to ?? 0))?.release ?? null
  const live =
    env.live_deployment && env.live_deployment !== d.number
      ? await ctx.store.deployment(env.id, env.live_deployment)
      : undefined
  return live?.release ?? null
}

/** Supervisor → CP wire (contracts §2.2), authenticated by the env's box token. */
export function svRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>()
  const { store } = ctx

  // The supervisor binary the Box's PID 1 downloads on every start.
  r.get('/bin/:file', (c) => {
    const file = c.req.param('file')
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.')) throw fail('not_found', 'no such file')
    const path = join(ctx.config.svBinDir, file)
    if (!existsSync(path) || !statSync(path).isFile())
      throw fail('not_found', `no supervisor build ${file}`, 'build it into SV_BIN_DIR')
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(statSync(path).size),
        'cache-control': 'no-store',
      },
    })
  })

  r.use('/v1/*', requireBoxToken(store))

  /**
   * The deployment the CP last asked this Box to build/activate (or the live one). Before the first
   * deploy there is none, but the secrets are still returned so the CP's health probe works.
   * `deployment` is the release dir to use; `spec.deployment` is the CP deployment that wrote the spec.
   */
  r.get('/v1/spec', async (c) => {
    const env = c.get('env')
    const app = c.get('app')
    // forward_secret opens the app path only, control_secret the /.boxlite/sv/* API only (F3).
    const secrets = { forward_secret: env.forward_secret, control_secret: env.control_secret }
    const phase = c.req.query('phase')
    if (phase && phase !== 'boot' && phase !== 'build' && phase !== 'runtime')
      throw fail('invalid_request', 'unknown Spec phase')
    const pending = env.requested_deployment !== null && env.requested_deployment !== env.live_deployment
    const idle = { spec: null, deployment: null, ...secrets, env: {}, snapshot: null }
    if (phase === 'boot' && pending) return c.json({ ...idle, retry: true })
    const n = env.requested_deployment ?? env.live_deployment
    const dep = n ? await store.deployment(env.id, n) : undefined
    const spec = dep?.spec_version ? await store.spec(env.id, dep.spec_version) : undefined
    const release = dep ? await releaseOf(ctx, env, dep) : null
    const metadata = { ...idle, spec: spec ?? null }
    if (!phase && env.active_box_id) {
      // An old Supervisor can still be finishing a build after the worker restores the live pointer.
      const finishing = await store.get(
        "SELECT number FROM deployments WHERE env_id = ? AND box_id = ? AND legacy_source = 'read' AND number IS DISTINCT FROM ? LIMIT 1",
        env.id,
        env.active_box_id,
        n,
      )
      if (finishing) throw legacySpecPending()
    }
    const query = c.req.query()
    const recovering = query.operation !== undefined || query.version !== undefined || query.box !== undefined
    if (phase === 'boot') return c.json({ ...metadata, deployment: release, box: env.active_box_id })
    let source = dep
    let buildSpec = spec
    if (recovering) {
      const identity = recoverySchema.safeParse(query)
      if (!phase || !identity.success) throw fail('invalid_request', 'incomplete recovery identity')
      const { operation, version, box } = identity.data
      if (pending || !release || operation !== dep?.number || version !== spec?.version || box !== env.active_box_id)
        throw fail('conflict', 'the live release or Box changed during recovery')
      const verified = await store.get<Pick<EnvRow, 'box_image' | 'box_size' | 'box_volumes'>>(
        `SELECT e.box_image, e.box_size, e.box_volumes FROM envs e JOIN apps a ON a.id = e.app_id
         JOIN deployments d ON d.env_id = e.id AND d.number = e.live_deployment
         JOIN box b ON b.id = e.active_box_id AND b.app_id = a.id AND b.environment_id = e.id
           AND b."organizationId" = a.org_id AND b."desiredState" <> 'destroyed'
         JOIN box_tokens t ON t.env_id = e.id AND t.revoked_at IS NULL
           AND t.hash = encode(sha256(convert_to(b.env->>'BOXLITE_BOX_TOKEN', 'UTF8')), 'hex')
         WHERE e.id = ? AND d.number = ? AND d.spec_version = ? AND b.id = ? AND t.hash = ?
           AND (e.requested_deployment IS NULL OR e.requested_deployment = d.number)`,
        env.id,
        operation,
        version,
        box,
        c.get('boxTokenHash'),
      )
      if (!verified) throw fail('conflict', 'the credential does not belong to the active recovery Box')
      source = await store.deployment(env.id, release)
      buildSpec = source?.spec_version ? await store.spec(env.id, source.spec_version) : undefined
      if (
        source?.kind !== 'deploy' ||
        !buildSpec ||
        !spec ||
        verified.box_image !== buildSpec.runtime.image ||
        verified.box_size !== buildSpec.runtime.size ||
        (verified.box_volumes ?? '') !== volumeKey(buildSpec.volumes) ||
        (verified.box_volumes ?? '') !== volumeKey(spec.volumes)
      )
        throw fail('conflict', 'the active Box cannot restore this release', 'deploy on a compatible Box')
    }

    const starting = pending && dep?.status === 'starting' && (dep.kind !== 'deploy' || dep.built)
    if (phase === 'runtime' || (!phase && starting && dep?.kind === 'deploy' && dep.built)) {
      if ((!starting && !recovering) || !spec || !release) throw fail('conflict', 'the release is not ready to start')
      return c.json({
        ...metadata,
        phase,
        deployment: phase ? release : null,
        env: await ctx.resources.runtimeEnv(app, env, spec),
      })
    }
    if (!phase && !pending) return c.json(metadata)

    const building = pending && dep?.kind === 'deploy' && dep.status === 'building' && dep.box_id === env.active_box_id
    const legacy = !phase && building && !dep.built && dep.legacy_source === 'authorized'
    if (!phase && !legacy) throw legacySpecPending()
    if ((!building && !recovering) || !release || !source?.snapshot_id || !buildSpec)
      throw fail('conflict', 'no source is authorized for this build')
    const id = source.snapshot_id
    const querySuffix = legacy ? `?deployment=${release}` : ''
    return c.json({
      ...metadata,
      spec: buildSpec,
      deployment: release,
      phase: 'build',
      env: await ctx.resources.buildEnv(app, env, buildSpec),
      snapshot: { id, url: `${ctx.config.supervisorUrl}/sv/v1/snapshots/${id}${querySuffix}` },
    })
  })

  // Only snapshots of this env's own deployments: same App is not enough (env X's box must not read env Y's source).
  r.get('/v1/snapshots/:id', async (c) => {
    const env = c.get('env')
    const id = c.req.param('id')
    const snap = await store.snapshot(env.app_id, id)
    const used =
      snap &&
      (await store.get('SELECT 1 AS ok FROM deployments WHERE env_id = ? AND snapshot_id = ? LIMIT 1', env.id, id))
    if (!snap || !used) throw fail('not_found', 'no such snapshot')
    const legacy = c.req.query('deployment')
    if (legacy !== undefined) {
      const number = z.coerce.number().int().positive().safeParse(legacy)
      if (!number.success || !env.active_box_id) throw fail('invalid_request', 'invalid build snapshot request')
      const marked = await store.run(
        `UPDATE deployments d SET legacy_source = 'read' FROM envs e
         WHERE e.id = ? AND d.env_id = e.id AND d.number = ? AND d.number = e.requested_deployment
           AND d.box_id = e.active_box_id AND e.active_box_id = ? AND d.snapshot_id = ?
           AND d.kind = 'deploy' AND d.status = 'building' AND d.built = 0
           AND d.legacy_source IN ('authorized', 'read') RETURNING d.number`,
        env.id,
        number.data,
        env.active_box_id,
        id,
      )
      if (!marked.changes) throw fail('conflict', 'the build snapshot is no longer authorized')
    }
    return new Response(Readable.toWeb(snapshotTarGz(ctx.blobs, env.app_id, snap.manifest)) as ReadableStream, {
      headers: { 'content-type': 'application/gzip' },
    })
  })

  r.post('/v1/logs', async (c) => {
    const env = c.get('env')
    const lines = await body(c, logSchema)
    const stored: LogLine[] = lines.map((l) => ({
      ts: l.ts && !Number.isNaN(Date.parse(l.ts)) ? new Date(l.ts).toISOString() : new Date().toISOString(),
      source: l.source,
      level: l.level,
      line: l.line,
      deployment: l.deployment ?? null,
    }))
    // Per-env caps (F8): 500 lines per push, 8 KB per line, 200 lines/s (burst 2000). Excess is
    // dropped with a 200, never a 4xx: the supervisor would retry a rejected batch forever.
    const { accepted, dropped } = await admitLogs(ctx, env.id, stored, async (ls) => {
      await recordLogs(ctx, env.id, ls)
      await ctx.orchestrator.onLogs(env, ls)
    })
    return c.json({ ok: true, accepted: accepted.length, dropped })
  })

  r.post('/v1/status', async (c) => {
    const env = c.get('env')
    const s = await body(c, statusSchema)
    if (env.active_box_id && (s.phase === 'failed' || s.phase === 'live')) {
      await store.run(
        "UPDATE deployments SET legacy_source = 'ended' WHERE env_id = ? AND box_id = ? AND number = ? AND legacy_source = 'read'",
        env.id,
        env.active_box_id,
        s.deployment,
      )
    }
    if (s.phase === 'failed' && s.step === 'spec' && isLegacySpecPending(s.error)) return c.json({ ok: true })
    await ctx.orchestrator.onSupervisorStatus(env, {
      deployment: s.deployment,
      operation: s.operation,
      spec_version: s.spec_version,
      phase: s.phase,
      step: s.step,
      error: s.error,
      log_tail: s.log_tail ?? undefined,
      services: (s.services ?? undefined) as SupervisorStatus['services'],
    })
    return c.json({ ok: true })
  })

  return r
}
