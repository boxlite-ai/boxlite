import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { snapshotTarGz } from '../blobs.js';
import type { Change, Deployment, DeploymentRequest } from '../db.js';
import { ACTIVE_STATUSES, now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { depTopic } from '../events.js';
import { credentialOf, limitsOf, sseBusy, sseSlot } from '../limits.js';
import { MAX_SNAPSHOT_BYTES } from '../platform.js';
import { deploymentView } from '../views.js';
import { prepare } from './plan.js';
import { body, envOf, intParam, migrationsSchema, type C } from './util.js';

const createSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deploy'),
    snapshot_id: z.string(),
    manifest: z.unknown(),
    base_version: z.number().int().min(0).optional(),
    message: z.string().max(500).optional(),
    force: z.boolean().optional(),
    migrations: migrationsSchema,
  }),
  z.object({
    kind: z.literal('apply'),
    snapshot_id: z.string().optional(),
    manifest: z.unknown(),
    base_version: z.number().int().min(0).optional(),
    message: z.string().max(500).optional(),
    force: z.boolean().optional(),
    migrations: migrationsSchema,
  }),
  z.object({ kind: z.literal('rollback'), to: z.number().int().min(1), with_database: z.boolean().optional(), message: z.string().max(500).optional() }),
]);

export function deploymentRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  const { store } = ctx;

  r.post('/envs/:env/deployments', async (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    const b = await body(c, createSchema);
    const idem = c.req.header('idempotency-key')?.slice(0, 200) || null;
    if (idem) {
      const existing = store.deploymentByIdempotencyKey(env.id, idem);
      if (existing) return c.json(deploymentView(ctx, app, env, existing), 200);
    }

    // F8: a bounded queue per env. Idempotent replays were answered above, before this check.
    const waiting = store.deploymentsWhere("env_id = ? AND status = 'queued' ORDER BY number", env.id);
    const max = limitsOf(ctx).limits.queuedDeploymentsPerEnv;
    if (waiting.length >= max) {
      const first = store.deploymentsWhere(`env_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY number LIMIT 1`, env.id, ...ACTIVE_STATUSES)[0] ?? waiting[0]!;
      throw fail('conflict', `${waiting.length} deployments are already queued in "${env.name}" (at most ${max})`, `wait for #${first.number} to finish (\`boxlite-app deployments ${first.number} --follow\`), then retry`, {
        queued: waiting.map((w) => w.number),
        wait_for: first.number,
      });
    }

    let request: DeploymentRequest;
    let changes: Change[];
    let message: string | null = b.message ?? null;
    let baseVersion: number | null = null;
    let snapshotId: string | null = null;

    if (b.kind === 'rollback') {
      const problem = ctx.orchestrator.rollbackProblem(env, b.to);
      if (problem) throw fail('not_found', problem, 'pick a release listed by `boxlite-app deployments` that is still on the Box');
      const live = env.live_deployment ? store.deployment(env.id, env.live_deployment) : undefined;
      request = { kind: 'rollback', to: b.to, with_database: b.with_database ?? false };
      changes = [{ kind: '~', path: 'release', from: live?.release ?? null, to: store.deployment(env.id, b.to)!.release }];
      if (b.with_database) changes.push({ kind: '~', path: 'database', to: `restore to the state before the first migration after #${b.to}` });
      message = message ?? `Roll back to #${b.to}`;
      baseVersion = store.effectiveSpecVersion(env.id);
    } else {
      let uploadBytes: number | undefined;
      if (b.snapshot_id) {
        const snap = store.snapshot(app.id, b.snapshot_id);
        if (!snap) throw fail('not_found', `snapshot ${b.snapshot_id} not found`, 'upload the project again (`boxlite-app deploy` does this)');
        uploadBytes = snap.bytes;
        snapshotId = snap.id;
      }
      const p = prepare(ctx, app, env, { manifest: b.manifest, base_version: b.base_version, migrations: b.migrations, uploadBytes });
      if (p.errors.length || !p.manifest) {
        throw fail('invalid_manifest', `${p.errors.length} problem(s) in boxlite.toml`, 'run `boxlite-app check` and fix the errors', { errors: p.errors, warnings: p.warnings });
      }
      if (uploadBytes !== undefined && uploadBytes > MAX_SNAPSHOT_BYTES) throw fail('invalid_manifest', 'snapshot too large');
      if (p.stale && !b.force) {
        throw fail('stale_base', `environment "${env.name}" is at spec v${p.latest}, you planned against v${b.base_version ?? 0}`, 'run `boxlite-app plan` again, or pass --force', { latest_version: p.latest });
      }
      request = { kind: b.kind, manifest: p.manifest, migrations: p.migrations, force: b.force ?? false };
      changes = p.changes;
      baseVersion = b.base_version ?? 0;
    }

    const dep = store.insertDeployment(
      {
        kind: b.kind,
        status: 'queued',
        message,
        by: c.get('actor'),
        created_at: now(),
        started_at: null,
        finished_at: null,
        spec_version: null,
        base_version: baseVersion,
        snapshot_id: snapshotId,
        steps: [],
        changes,
        error: null,
        request,
        idempotency_key: idem,
        release: null,
        box_id: null,
        built: false,
        restore_point: null,
        live_at: null,
      },
      env.id,
    );
    ctx.orchestrator.enqueue(env.id, dep.number);
    return c.json(deploymentView(ctx, app, env, dep), 202);
  });

  r.get('/envs/:env/deployments', (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 200);
    return c.json(store.deployments(env.id, limit).map((d) => deploymentView(ctx, app, env, d)));
  });

  const depOf = (c: C): Deployment => {
    const env = envOf(ctx, c);
    const n = intParam(c.req.param('n'), 'deployment number');
    const d = store.deployment(env.id, n);
    if (!d) throw fail('not_found', `no deployment #${n} in env "${env.name}"`);
    return d;
  };

  r.get('/envs/:env/deployments/:n', (c) => {
    const d = depOf(c);
    return c.json(deploymentView(ctx, c.get('app'), envOf(ctx, c), d, true));
  });

  r.post('/envs/:env/deployments/:n/cancel', (c) => {
    const d = depOf(c);
    const out = ctx.orchestrator.cancel(d.env_id, d.number);
    return c.json(deploymentView(ctx, c.get('app'), envOf(ctx, c), out), 202);
  });

  /**
   * SSE: replays stored events after Last-Event-ID, then follows live ones, and ends after `done`.
   * Subscribing before the replay (and de-duplicating by seq) means no event can fall in between.
   */
  r.get('/envs/:env/deployments/:n/events', (c) => {
    const d = depOf(c);
    const after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0) || 0;
    const release = sseSlot(ctx, d.env_id, credentialOf(c));
    if (!release) return sseBusy(c, ctx);
    const heartbeatMs = limitsOf(ctx).limits.sseHeartbeatMs;
    return streamSSE(c, async (stream) => {
      const queue: { seq: number; event: string; data: unknown }[] = [];
      let wake: (() => void) | null = null;
      let aborted = false;
      const unsubscribe = ctx.bus.subscribe(depTopic(d.env_id, d.number), (ev) => {
        queue.push(ev as { seq: number; event: string; data: unknown });
        wake?.();
      });
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      let last = after;
      let done = false;
      const send = async (ev: { seq: number; event: string; data: unknown }) => {
        if (ev.seq <= last) return;
        last = ev.seq;
        await stream.writeSSE({ id: String(ev.seq), event: ev.event, data: JSON.stringify(ev.data) });
        if (ev.event === 'done') done = true;
      };
      try {
        for (const ev of store.events(d.env_id, d.number, after)) {
          await send(ev);
          if (done) return;
        }
        // A finished deployment always has a stored `done`; guard against one that predates it.
        const cur = store.deployment(d.env_id, d.number)!;
        if (!ACTIVE_STATUSES.includes(cur.status) && !queue.length) {
          const env = envOf(ctx, c);
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ status: cur.status, deployment: deploymentView(ctx, c.get('app'), env, cur) }) });
          return;
        }
        while (!done && !aborted) {
          while (queue.length && !done) await send(queue.shift()!);
          if (done || aborted) break;
          const timedOut = await new Promise<boolean>((res) => {
            const t = setTimeout(() => res(true), heartbeatMs);
            wake = () => {
              clearTimeout(t);
              res(false);
            };
          });
          wake = null;
          if (timedOut && !aborted) await stream.write(': keepalive\n\n');
        }
      } finally {
        unsubscribe();
        release();
      }
    });
  });

  r.get('/envs/:env/deployments/:n/source', (c) => {
    const d = depOf(c);
    if (!d.snapshot_id) throw fail('not_found', `deployment #${d.number} has no source snapshot`);
    const snap = store.snapshot(c.get('app').id, d.snapshot_id);
    if (!snap) throw fail('not_found', `snapshot ${d.snapshot_id} is gone`);
    const stream = Readable.toWeb(snapshotTarGz(ctx.blobs, c.get('app').id, snap.manifest)) as ReadableStream;
    return new Response(stream, {
      headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${c.get('app').name}-${d.number}.tar.gz"` },
    });
  });

  return r;
}
