import { Hono } from 'hono';
import { z } from 'zod';
import type { SQLInputValue } from 'node:sqlite';
import { buildAgentContext, schedulesOf, variablesOf } from '../agent-context.js';
import { ackFinding, unackFinding } from '../services/acks.js';
import { newId, requireAppKey, type Vars } from '../auth.js';
import { cliPackage } from '../cli-version.js';
import type { Ctx } from '../ctx.js';
import { now, type LogLine } from '../db.js';
import { fail } from '../errors.js';
import { recordFeedback } from '../feedback.js';
import { TABLES_QUERY } from '../services/db.js';
import { deploymentLogs, parseSince, storedLevelsAtLeast } from '../services/logs.js';
import { deploymentView, envStatus } from '../views.js';
import { readVolume, removeVolume, VOLUME_FILE_MAX, volumePath, writeVolume } from '../volume-files.js';
import { forward } from '../proxy/forward.js';
import { body, envOf, intParam, type C } from './util.js';
import { appProviders } from '../enduser/config.js';

/**
 * Endpoints for the agent-facing CLI (contracts §4.1 "CLI extras"): discovery (whoami, context,
 * CLI version), diagnosis (probe, log search, deployment timeline), data (applied migrations,
 * reset) and runtime views (variables, schedules, volume files).
 */

const MAX_LOG_LINES = 5000;

const latestCli = async (ctx: Ctx): Promise<string | null> => (await cliPackage(ctx.config.cliTgzPath).catch(() => null))?.version ?? null;

function dbUrl(c: C, ctx: Ctx): string {
  const env = envOf(ctx, c);
  if (!env.db_url) throw fail('not_found', `env "${env.name}" has no database`, 'add [database] to boxlite.toml and run `boxlite-app apply --yes`');
  return env.db_url;
}

function stepTimes(ctx: Ctx, envId: string, number: number): Map<string, { started_at: string | null; finished_at: string | null }> {
  const rows = ctx.store.all<{ data: string; ts: string }>("SELECT data, ts FROM deployment_events WHERE env_id = ? AND number = ? AND event = 'step' ORDER BY seq", envId, number);
  const out = new Map<string, { started_at: string | null; finished_at: string | null }>();
  for (const r of rows) {
    const ev = JSON.parse(r.data) as { name: string; status: string };
    const cur = out.get(ev.name) ?? { started_at: null, finished_at: null };
    if (ev.status === 'running' && !cur.started_at) cur.started_at = r.ts;
    else if (ev.status !== 'running') cur.finished_at = r.ts;
    out.set(ev.name, cur);
  }
  return out;
}

export function mountCliExtras(app: Hono, ctx: Ctx): void {
  app.get('/cli/version', async (c) => {
    const pkg = await cliPackage(ctx.config.cliTgzPath).catch(() => null);
    if (!pkg) return c.json({ error: { code: 'not_found', message: 'this control plane has no CLI package', next: 'build it into CLI_TGZ_PATH (deploy/deploy-cp.sh does)' } }, 404);
    return c.json({ ...pkg, url: `${ctx.config.publicUrl}/cli/boxlite-app.tgz` });
  });

  const r = new Hono<{ Variables: Vars }>();
  r.use('*', requireAppKey(ctx.store, ctx.config.adminToken));

  r.get('/whoami', async (c) => {
    const a = c.get('app');
    const actor = c.get('actor');
    const last4 = /^key:…(.+)$/.exec(actor)?.[1];
    const key = last4 ? (ctx.store.get<{ last4: string; created_at: string }>('SELECT last4, created_at FROM keys WHERE app_id = ? AND last4 = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', a.id, last4) ?? null) : null;
    return c.json({
      app: a.name,
      actor,
      key,
      scope: `app:${a.name}`,
      environments: ctx.store.envs(a.id).map((e) => ({ name: e.name, status: envStatus(ctx, e), url: ctx.resources.appUrl(a.name, e.name) })),
      control_plane: ctx.config.publicUrl,
      sign_in_providers: appProviders(ctx, a),
      cli: { latest_version: await latestCli(ctx), download_url: `${ctx.config.publicUrl}/cli/boxlite-app.tgz` },
    });
  });

  /** boxlite-app feedback "<message>": the agent reports something the platform got wrong, then carries on. */
  r.post('/feedback', async (c) => {
    const b = await body(
      c,
      z.object({ message: z.string().trim().min(10).max(4000), command: z.string().max(500).optional(), env: z.string().max(64).optional(), cli_version: z.string().max(32).optional() }),
    );
    const out = recordFeedback(ctx, c.get('app').id, c.get('actor'), b);
    return c.json({ ...out, next: 'thanks: the BoxLite team reads every report; continue the user\'s task with a workaround' }, 201);
  });

  r.get('/envs/:env/context', async (c) => c.json(await buildAgentContext(ctx, c.get('app'), envOf(ctx, c), await latestCli(ctx))));
  r.post('/envs/:env/findings/:id/ack', async (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    const b = await body(c, z.object({ reason: z.string().max(1000) }));
    const current = await buildAgentContext(ctx, app, env, await latestCli(ctx));
    return c.json(ackFinding(ctx, app, env, current, c.req.param('id'), b.reason, c.get('actor')));
  });
  r.delete('/envs/:env/findings/:id/ack', (c) => c.json(unackFinding(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));
  // The app-level context is the main env's: one AgentContext shape, rendered as markdown by the
  // CLI only (`boxlite-app app context`). Its old markdown renderer here still described path prefixes.
  r.get('/context', async (c) => {
    const a = c.get('app');
    const main = ctx.store.envByName(a.id, 'main');
    if (!main) throw fail('not_found_env', `app "${a.name}" has no main environment`, '`boxlite-app app status` lists the environments');
    return c.json(await buildAgentContext(ctx, a, main, await latestCli(ctx)));
  });

  /** GET the health path (or `?path=`) through the same proxy path visitors use; wakes a sleeping Box. */
  r.get('/envs/:env/probe', async (c) => {
    const a = c.get('app');
    const env = envOf(ctx, c);
    const spec = ctx.resources.currentSpec(env);
    const exposed = spec?.services.find((s) => s.port !== undefined || s.static !== undefined);
    const path = c.req.query('path') || (exposed?.command ? (exposed.health ?? '/') : '/');
    const url = `${ctx.resources.appUrl(a.name, env.name).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    if (!env.live_deployment || !env.box_id) return c.json({ url, path, status: null, ok: false, ms: 0, starting: false, reason: 'not_deployed', content_type: null, body_head: '' });
    const started = Date.now();
    let res: Response;
    try {
      res = await forward(ctx, a, env, { method: 'GET', path: path.startsWith('/') ? path : `/${path}`, headers: new Headers({ 'user-agent': 'boxlite-doctor', accept: '*/*' }), body: null });
    } catch (err) {
      return c.json({ url, path, status: null, ok: false, ms: Date.now() - started, starting: false, reason: 'unreachable', content_type: null, body_head: (err as Error).message.slice(0, 300) });
    }
    const starting = res.headers.get('x-boxlite-starting') === '1';
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const ok = res.status >= 200 && res.status < 300;
    return c.json({ url, path, status: res.status, ok, ms: Date.now() - started, starting, reason: ok ? 'ok' : starting ? 'starting' : 'http_error', content_type: res.headers.get('content-type'), body_head: body });
  });

  r.get('/envs/:env/logs/search', (c) => {
    const env = envOf(ctx, c);
    const where = ['env_id = ?'];
    const params: SQLInputValue[] = [env.id];
    const source = c.req.query('source');
    if (source) (where.push('source = ?'), params.push(source));
    const level = c.req.query('level');
    if (level && level !== 'info') {
      const levels = level === 'error' || level === 'warn' ? storedLevelsAtLeast(level) : null;
      if (!levels) throw fail('invalid_request', 'level must be error, warn or info', 'use --level error');
      where.push(`lower(level) IN (${levels.map(() => '?').join(', ')})`);
      params.push(...levels);
    }
    const since = parseSince(c.req.query('since'));
    if (since) (where.push('ts >= ?'), params.push(since));
    const until = parseSince(c.req.query('until'));
    if (until) (where.push('ts <= ?'), params.push(until));
    const deployment = c.req.query('deployment');
    if (deployment) (where.push('deployment = ?'), params.push(intParam(deployment, 'deployment')));
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), MAX_LOG_LINES);
    const rows = ctx.store.all<LogLine>(`SELECT id, ts, source, level, line, deployment FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params, limit);
    return c.json(rows.reverse().map((l) => ({ id: l.id, ts: l.ts, source: l.source, level: l.level, line: l.line, deployment: l.deployment ?? null })));
  });

  /** Steps with timestamps, then every log line of the deployment (its own and, for apply/rollback, its release's). */
  r.get('/envs/:env/deployments/:n/timeline', (c) => {
    const a = c.get('app');
    const env = envOf(ctx, c);
    const n = intParam(c.req.param('n'), 'deployment number');
    const d = ctx.store.deployment(env.id, n);
    if (!d) throw fail('not_found', `no deployment #${n} in env "${env.name}"`, '`boxlite-app app deployments` lists them');
    const times = stepTimes(ctx, env.id, n);
    const steps = d.steps.map((s) => ({ ...s, started_at: times.get(s.name)?.started_at ?? null, finished_at: times.get(s.name)?.finished_at ?? null }));
    const logs = deploymentLogs(ctx.store, env.id, d, MAX_LOG_LINES);
    return c.json({
      deployment: deploymentView(ctx, a, env, d, true),
      steps,
      logs: logs.map((l) => ({ id: l.id, ts: l.ts, source: l.source, level: l.level, line: l.line, deployment: l.deployment ?? null })),
      truncated: logs.length >= MAX_LOG_LINES,
    });
  });

  r.get('/envs/:env/db/applied', async (c) => c.json(await ctx.appdb.listApplied(dbUrl(c, ctx))));

  /** Non-main only: snapshot, then drop and recreate `public`; migrations re-run on the next apply/deploy. */
  r.post('/envs/:env/db/reset', async (c) => {
    const a = c.get('app');
    const env = envOf(ctx, c);
    if (env.name === 'main') throw fail('forbidden', 'db reset is not available on main', 'on main use `boxlite-app app db restore --to <iso8601> --yes`');
    const url = dbUrl(c, ctx);
    const tables = await ctx.appdb.query(url, [TABLES_QUERY], { write: false });
    const snapshot = newId('dbs');
    ctx.store.run('INSERT INTO db_snapshots (id, env_id, message, ts, by) VALUES (?, ?, ?, ?, ?)', snapshot, env.id, 'before db reset', now(), c.get('actor'));
    await ctx.appdb.query(url, ['DROP SCHEMA IF EXISTS public CASCADE', 'CREATE SCHEMA public'], { write: true });
    const dropped = (tables.rows as string[][]).map((row) => row[0]!).filter((t) => t !== 'boxlite_migrations');
    ctx.store.recordActivity(a.id, env.name, c.get('actor'), 'db.reset', { dropped, snapshot });
    return c.json({ reset: env.name, dropped_tables: dropped, snapshot });
  });

  r.get('/envs/:env/vars', (c) => {
    const env = envOf(ctx, c);
    return c.json(variablesOf(ctx, c.get('app'), env, ctx.resources.currentSpec(env)));
  });

  r.get('/envs/:env/schedules', (c) => {
    const env = envOf(ctx, c);
    return c.json(schedulesOf(ctx, env, ctx.resources.currentSpec(env)));
  });

  r.get('/envs/:env/volumes', (c) => {
    const env = envOf(ctx, c);
    return c.json((ctx.resources.currentSpec(env)?.volumes ?? []).map((v) => ({ name: v.name, mount: v.mount, mode: v.mode })));
  });

  /** The env's Box must run for its volumes to be mounted; a sleeping one is started first. */
  const runningEnv = async (c: C) => {
    const env = envOf(ctx, c);
    const volumes = ctx.resources.currentSpec(env)?.volumes ?? [];
    const target = volumePath(volumes, c.req.param('name') ?? '', c.req.query('path'));
    if (!env.box_id || !env.box_url || !env.live_deployment) throw fail('not_found', `nothing is deployed in ${env.name} yet, so its volumes are not mounted`, '`boxlite-app deploy` first');
    try {
      await ctx.resources.ensureRunning(env.id, () => undefined);
    } catch (err) {
      throw fail('unavailable', `the Box of ${env.name} is not answering: ${(err as Error).message}`, 'rerun in 30 s; `boxlite-app doctor` checks the Box');
    }
    return { env, ...target };
  };

  r.get('/envs/:env/volumes/:name/files', async (c) => {
    const { env, volume, rel, abs } = await runningEnv(c);
    const res = await readVolume(env, volume.name, rel, abs);
    if ((res.headers.get('content-type') ?? '').startsWith('application/json')) {
      const listing = (await res.json()) as { entries?: unknown[] };
      return c.json({ volume: volume.name, path: rel, type: 'dir', entries: listing.entries ?? [] });
    }
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    const size = res.headers.get('content-length') ?? res.headers.get('x-boxlite-file-size');
    if (size) headers['x-boxlite-file-size'] = size;
    return new Response(res.body, { headers });
  });

  r.put('/envs/:env/volumes/:name/files', async (c) => {
    const { env, volume, rel, abs } = await runningEnv(c);
    if (rel === '/') throw fail('invalid_request', 'give a file path inside the volume', `\`boxlite-app app volume cp <file> ${volume.name}:/<name>\``);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > VOLUME_FILE_MAX) throw fail('invalid_request', `file is ${declared} bytes; the limit is ${VOLUME_FILE_MAX}`, 'split the file or let the app write it');
    const body = await c.req.arrayBuffer();
    if (body.byteLength > VOLUME_FILE_MAX) throw fail('invalid_request', `file is ${body.byteLength} bytes; the limit is ${VOLUME_FILE_MAX}`, 'split the file or let the app write it');
    const out = await writeVolume(env, volume.name, rel, abs, body, c.req.query('overwrite') === '1');
    return c.json({ volume: volume.name, path: rel, ...out });
  });

  r.delete('/envs/:env/volumes/:name/files', async (c) => {
    const { env, volume, rel, abs } = await runningEnv(c);
    if (rel === '/') throw fail('invalid_request', `refusing to delete the volume ${volume.name} itself`, `name what is inside it: \`boxlite-app app volume ls ${volume.name}\``);
    const out = await removeVolume(env, volume.name, rel, abs, c.req.query('recursive') === '1');
    ctx.store.recordActivity(c.get('app').id, env.name, c.get('actor'), 'volume.delete', { volume: volume.name, path: rel, removed: out.removed });
    return c.json({ volume: volume.name, path: rel, ...out });
  });

  app.route('/v1/apps/:app', r);
}
