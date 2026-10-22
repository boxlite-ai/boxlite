import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireBoxToken, type Vars } from '../auth.js';
import { snapshotTarGz } from '../blobs.js';
import type { Deployment, EnvRow, LogLine } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { admitLogs } from '../limits.js';
import { recordLogs } from '../logsink.js';
import type { SupervisorStatus } from '../supervisor.js';
import { body } from './util.js';

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
  .max(5000);

const statusSchema = z.object({
  deployment: z.number().int(),
  phase: z.enum(['building', 'built', 'starting', 'live', 'failed']),
  step: z.string().optional(),
  error: z.string().optional(),
  log_tail: z.array(z.string()).nullable().optional(),
  // Go encodes an empty slice as null.
  services: z.array(z.object({ name: z.string(), state: z.string() }).passthrough()).nullable().optional(),
});

/** The release dir a deployment runs from: its own for deploy, the target's for rollback, the live one for apply. */
function releaseOf(ctx: Ctx, env: EnvRow, d: Deployment): number | null {
  if (d.kind === 'deploy') return d.number;
  if (d.release) return d.release;
  if (d.kind === 'rollback') return ctx.store.deployment(env.id, d.request.to ?? 0)?.release ?? null;
  const live = env.live_deployment && env.live_deployment !== d.number ? ctx.store.deployment(env.id, env.live_deployment) : undefined;
  return live?.release ?? null;
}

/** Supervisor → CP wire (contracts §2.2), authenticated by the env's box token. */
export function svRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  const { store } = ctx;

  // The supervisor binary the Box's PID 1 downloads on every start.
  r.get('/bin/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith('.')) throw fail('not_found', 'no such file');
    const path = join(ctx.config.svBinDir, file);
    if (!existsSync(path) || !statSync(path).isFile()) throw fail('not_found', `no supervisor build ${file}`, 'build it into SV_BIN_DIR');
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(statSync(path).size), 'cache-control': 'no-store' },
    });
  });

  r.use('/v1/*', requireBoxToken(store));

  /**
   * The deployment the CP last asked this Box to build/activate (or the live one). Before the first
   * deploy there is none, but the secrets are still returned so the CP's health probe works.
   * `deployment` is the release dir to use; `spec.deployment` is the CP deployment that wrote the spec.
   */
  r.get('/v1/spec', (c) => {
    const env = c.get('env');
    const app = c.get('app');
    // forward_secret opens the app path only, control_secret the /.boxlite/sv/* API only (F3).
    const secrets = { forward_secret: env.forward_secret, control_secret: env.control_secret };
    const n = env.requested_deployment ?? env.live_deployment;
    const dep = n ? store.deployment(env.id, n) : undefined;
    const spec = dep?.spec_version ? store.spec(env.id, dep.spec_version) : undefined;
    if (!dep || !spec) {
      return c.json({ spec: null, deployment: null, ...secrets, env: ctx.resources.runtimeEnv(app, env, undefined), snapshot: null });
    }
    const release = releaseOf(ctx, env, dep);
    const snapId = release ? store.deployment(env.id, release)?.snapshot_id : dep.snapshot_id;
    return c.json({
      spec,
      deployment: release,
      ...secrets,
      env: ctx.resources.runtimeEnv(app, env, spec),
      snapshot: snapId ? { id: snapId, url: `${ctx.config.publicUrl}/sv/v1/snapshots/${snapId}` } : null,
    });
  });

  // Only snapshots of this env's own deployments: same App is not enough (env X's box must not read env Y's source).
  r.get('/v1/snapshots/:id', (c) => {
    const env = c.get('env');
    const id = c.req.param('id');
    const snap = store.snapshot(env.app_id, id);
    const used = snap && store.get('SELECT 1 AS ok FROM deployments WHERE env_id = ? AND snapshot_id = ? LIMIT 1', env.id, id);
    if (!snap || !used) throw fail('not_found', 'no such snapshot');
    return new Response(Readable.toWeb(snapshotTarGz(ctx.blobs, env.app_id, snap.manifest)) as ReadableStream, { headers: { 'content-type': 'application/gzip' } });
  });

  r.post('/v1/logs', async (c) => {
    const env = c.get('env');
    const lines = await body(c, logSchema);
    const stored: LogLine[] = lines.map((l) => ({
      ts: l.ts && !Number.isNaN(Date.parse(l.ts)) ? new Date(l.ts).toISOString() : new Date().toISOString(),
      source: l.source,
      level: l.level,
      line: l.line,
      deployment: l.deployment ?? null,
    }));
    // Per-env caps (F8): 500 lines per push, 8 KB per line, 200 lines/s (burst 2000). Excess is
    // dropped with a 200, never a 4xx: the supervisor would retry a rejected batch forever.
    const { accepted, dropped } = admitLogs(ctx, env.id, stored, (ls) => {
      recordLogs(ctx, env.id, ls);
      ctx.orchestrator.onLogs(env, ls);
    });
    return c.json({ ok: true, accepted: accepted.length, dropped });
  });

  r.post('/v1/status', async (c) => {
    const env = c.get('env');
    const s = await body(c, statusSchema);
    ctx.orchestrator.onSupervisorStatus(env, {
      deployment: s.deployment,
      phase: s.phase,
      step: s.step,
      error: s.error,
      log_tail: s.log_tail ?? undefined,
      services: (s.services ?? undefined) as SupervisorStatus['services'],
    });
    return c.json({ ok: true });
  });

  return r;
}
