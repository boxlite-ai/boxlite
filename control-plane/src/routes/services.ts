import { Hono } from 'hono';
import { dbCoordinates } from '../services/db.js';
import type { Vars } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { body, envOf } from './util.js';
import { z } from 'zod';

export function serviceRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();

  /** Live state from the supervisor; falls back to its last status report when the Box is asleep. */
  r.get('/envs/:env/services', async (c) => {
    const env = envOf(ctx, c);
    if (!env.box_url) return c.json([]);
    const status = env.box_id ? await ctx.resources.boxStatus(env.box_id).catch(() => 'unknown') : 'missing';
    if (status === 'running') {
      try {
        const h = await ctx.supervisor.health(env.box_url, env.control_secret);
        ctx.store.updateEnv(env.id, { services: JSON.stringify(h.services) });
        return c.json(h.services.map((s) => ({ name: s.name, state: s.state, restarts: s.restarts ?? 0, last_exit_code: s.last_exit_code ?? null, health: s.health ?? null, pid: s.pid ?? null })));
      } catch {
        // fall through to the last report
      }
    }
    const last = (env.services ? JSON.parse(env.services) : []) as Record<string, unknown>[];
    return c.json(last.map((s) => ({ ...s, state: status === 'stopped' ? 'stopped (Box asleep)' : s.state, reported_at: env.services_at })));
  });

  r.post('/envs/:env/services/:name/restart', async (c) => {
    const env = envOf(ctx, c);
    if (!env.box_url) throw fail('not_found', 'this environment has no Box yet', 'run `boxlite-app deploy` first');
    const name = c.req.param('name');
    const spec = ctx.resources.currentSpec(env);
    if (name !== 'all' && !spec?.services.some((s) => s.name === name)) throw fail('not_found', `no service "${name}"`);
    await ctx.resources.ensureRunning(env.id, () => undefined);
    await ctx.supervisor.restart(env.box_url, env.control_secret, name === 'all' ? null : name);
    return c.json({ restarted: name }, 202);
  });

  r.post('/envs/:env/schedules/:name/run', async (c) => {
    const env = envOf(ctx, c);
    const out = await ctx.scheduler.run(c.get('app'), env, c.req.param('name'));
    return c.json(out);
  });

  r.get('/envs/:env/access', (c) => {
    const env = envOf(ctx, c);
    return c.json({ access: ctx.resources.effectiveAccess(env), source: env.access_override ? 'online' : 'manifest' });
  });

  /** An online override; it wins over boxlite.toml (plan shows it as `online_only`). null clears it. */
  r.put('/envs/:env/access', async (c) => {
    const env = envOf(ctx, c);
    const b = await body(c, z.object({ access: z.enum(['private', 'org', 'public']).nullable() }));
    ctx.store.updateEnv(env.id, { access_override: b.access });
    const fresh = ctx.store.envById(env.id)!;
    return c.json({ access: ctx.resources.effectiveAccess(fresh), source: fresh.access_override ? 'online' : 'manifest' });
  });

  r.get('/envs/:env/dev-env', async (c) => {
    const app = c.get('app');
    let env = envOf(ctx, c);
    const spec = ctx.store.spec(env.id);
    if (spec?.database && !env.db_url) {
      await ctx.resources.ensureDatabase(app.id, env.id);
      env = ctx.store.envById(env.id)!;
    }
    // No database password leaves the CP: `boxlite-app app dev` points DATABASE_URL at its local
    // `db proxy` (owner login, through the App key) and only needs the database's name here.
    const { DATABASE_URL: _password, ...vars } = ctx.resources.runtimeEnv(app, env, spec);
    return c.json({ env: vars, database: env.db_url ? { name: dbCoordinates(env.db_url).database } : null });
  });

  return r;
}
