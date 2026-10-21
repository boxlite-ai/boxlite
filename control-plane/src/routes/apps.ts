import { Hono } from 'hono';
import { z } from 'zod';
import { newAppKey, newId, newSecret, sha256hex, type Vars } from '../auth.js';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { nameProblem } from '../platform.js';
import { deploymentView, envSummary } from '../views.js';
import { body, type C } from './util.js';

/** Creates the app row, its key and the `main` env. Neon and the Box are created lazily. */
export function createApp(ctx: Ctx, name: string, actor = 'admin'): { app: AppRow; key: string } {
  const problem = nameProblem(name);
  if (problem) throw fail('invalid_request', `app name "${name}" ${problem}`);
  if (ctx.store.appByName(name)) throw fail('conflict', `an app named "${name}" already exists`);
  const deleted = ctx.store.appByNameAnyState(name);
  if (deleted?.deleted_at) {
    throw fail('conflict', `"${name}" belongs to a deleted app that is kept until ${deleted.purge_after}`, 'restore it from Recently deleted, or pick another name');
  }
  const key = newAppKey();
  const appId = newId('app');
  ctx.store.tx(() => {
    ctx.store.run('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)', appId, name, now());
    ctx.store.run('INSERT INTO keys (id, app_id, hash, last4, created_at) VALUES (?, ?, ?, ?, ?)', newId('key'), appId, sha256hex(key), key.slice(-4), now());
    ctx.store.run('INSERT INTO envs (id, app_id, name, created_at, gateway_secret) VALUES (?, ?, ?, ?, ?)', newId('env'), appId, 'main', now(), newSecret());
  });
  const app = ctx.store.appById(appId)!;
  ctx.store.recordActivity(app.id, null, actor, 'app.create', { name });
  return { app, key };
}

export function adminRoutes(ctx: Ctx) {
  const r = new Hono();
  r.post('/apps', async (c) => {
    const b = await body(c as unknown as C, z.object({ name: z.string() }));
    const { app, key } = createApp(ctx, b.name);
    return c.json({ app: { name: app.name, created_at: app.created_at, url: ctx.resources.appUrl(app.name, 'main') }, key }, 201);
  });
  return r;
}

export function adminSecretRoutes(ctx: Ctx) {
  const r = new Hono();
  // Secret refs look like `org/openai`, so the name may contain slashes.
  r.put('/secrets/:name{.+}', async (c) => {
    const name = c.req.param('name');
    if (!/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_./-]+$/.test(name)) throw fail('invalid_request', 'secret names look like <scope>/<name>, e.g. org/openai');
    const b = await body(c as unknown as C, z.object({ value: z.string().min(1) }));
    ctx.store.run('INSERT INTO org_secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', name, b.value, now());
    return c.json({ name, updated_at: now() });
  });
  r.get('/secrets', (c) => c.json(ctx.store.all<{ name: string; updated_at: string }>('SELECT name, updated_at FROM org_secrets ORDER BY name')));
  r.delete('/secrets/:name{.+}', (c) => {
    ctx.store.run('DELETE FROM org_secrets WHERE name = ?', c.req.param('name'));
    return c.body(null, 204);
  });
  return r;
}

/** Mounted under /v1/apps/:app (after App-key auth). */
export function appRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();

  r.get('/', (c) => {
    const app = c.get('app');
    return c.json({ name: app.name, created_at: app.created_at, url: ctx.resources.appUrl(app.name, 'main'), envs: ctx.store.envs(app.id).map((e) => envSummary(ctx, app, e)) });
  });

  r.get('/activity', (c) => {
    const app = c.get('app');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500);
    const rows = ctx.store.all<{ id: number; env: string | null; actor: string; action: string; detail: string | null; ts: string }>(
      'SELECT id, env, actor, action, detail, ts FROM activity WHERE app_id = ? ORDER BY id DESC LIMIT ?',
      app.id,
      limit,
    );
    return c.json(rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })));
  });

  r.get('/context', (c) => {
    const app = c.get('app');
    const data = contextData(ctx, app);
    if ((c.req.query('format') ?? 'markdown') === 'json') return c.json(data);
    return c.text(contextMarkdown(data), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });

  return r;
}

type ContextData = ReturnType<typeof contextData>;

function contextData(ctx: Ctx, app: AppRow) {
  return {
    app: app.name,
    url: ctx.resources.appUrl(app.name, 'main'),
    control_plane: ctx.config.publicUrl,
    database: app.neon_project_id ? { provider: 'neon', project: app.neon_project_id } : null,
    envs: ctx.store.envs(app.id).map((env) => {
      const spec = ctx.resources.currentSpec(env);
      const latest = ctx.store.spec(env.id);
      return {
        ...envSummary(ctx, app, env),
        spec: latest ?? null,
        live_spec_version: spec?.version ?? null,
        services: env.services ? JSON.parse(env.services) : [],
        services_at: env.services_at,
        recent_deployments: ctx.store.deployments(env.id, 5).map((d) => deploymentView(ctx, app, env, d)),
      };
    }),
    notes: [
      'Apps are served under a path prefix; use relative links or X-Forwarded-Prefix / BOXLITE_APP_URL.',
      'Schema changes go into migrations/NNNN_name.sql and are applied by `boxlite-app apply` or `deploy`.',
      'Applied migrations are immutable; add a new file instead of editing one.',
    ],
  };
}

function contextMarkdown(d: ContextData): string {
  const out: string[] = [`# ${d.app}`, '', `- URL (main): ${d.url}`, `- Control plane: ${d.control_plane}`];
  out.push(`- Database: ${d.database ? `Neon project ${d.database.project}` : 'none yet'}`, '');
  for (const e of d.envs) {
    out.push(`## env ${e.name} — ${e.status}`, '', `- URL: ${e.url}`, `- Access: ${e.access}`, `- Spec version: ${e.spec_version ?? '—'} (live: ${e.live_spec_version ?? '—'})`);
    const s = e.spec;
    if (s) {
      out.push(`- Runtime: ${s.runtime.image}/${s.runtime.size}; build: ${s.runtime.build.length ? s.runtime.build.join(' && ') : '—'}`);
      out.push(`- Services: ${s.services.map((x) => `${x.name}${x.port !== undefined || x.static ? ' (exposed)' : ''}`).join(', ') || '—'}`);
      if (s.schedules.length) out.push(`- Schedules: ${s.schedules.map((x) => `${x.name} \`${x.cron}\` → ${x.target}`).join(', ')}`);
      if (s.database) out.push(`- Database: migrations in ${s.database.migrations}; applied ${s.database.applied.map((a) => a.file).join(', ') || 'none'}`);
      if (Object.keys(s.variables).length) out.push(`- Variables: ${Object.keys(s.variables).join(', ')}`);
      if (Object.keys(s.secrets).length) out.push(`- Secrets: ${Object.keys(s.secrets).join(', ')}`);
    }
    if (e.services.length) {
      out.push('', '| service | state | health | restarts |', '|---|---|---|---|');
      for (const sv of e.services as { name: string; state: string; health?: string; restarts?: number }[]) out.push(`| ${sv.name} | ${sv.state} | ${sv.health ?? ''} | ${sv.restarts ?? 0} |`);
    }
    if (e.recent_deployments.length) {
      out.push('', '| # | kind | status | message | created |', '|---|---|---|---|---|');
      for (const dep of e.recent_deployments) out.push(`| ${dep.number} | ${dep.kind} | ${dep.status} | ${(dep.message as string | null) ?? ''} | ${dep.created_at} |`);
      const failed = e.recent_deployments.find((x) => x.status === 'failed');
      const err = failed?.error as { step: string; message: string } | null | undefined;
      if (err) out.push('', `Last failure (#${failed!.number}, step ${err.step}): ${err.message}`);
    }
    out.push('');
  }
  out.push('## Notes', '', ...d.notes.map((n) => `- ${n}`), '');
  return out.join('\n');
}
