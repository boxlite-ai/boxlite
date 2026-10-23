import { SECRET_REF_RE } from '@microcloud/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { listFeedback } from '../feedback.js';
import { PLATFORM_ORG, appSecretNames, deleteAppSecret, orgSecretNames, setAppSecret } from '../orgs.js';
import { createApp } from '../services/apps.js';
import { envSummary } from '../views.js';
import { body, type C } from './util.js';
import { appProviders } from '../enduser/config.js';

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
  /** Secrets belong to an organization (orgs.ts): `?org=<id>`, the platform's own org by default. */
  const orgParam = (c: { req: { query: (k: string) => string | undefined } }): string => {
    const org = c.req.query('org') || PLATFORM_ORG;
    if (!ctx.store.get('SELECT 1 FROM orgs WHERE id = ?', org)) throw fail('not_found', `no organization "${org}"`);
    return org;
  };
  // Secret refs look like `org/openai`, so the name may contain slashes.
  r.put('/secrets/:name{.+}', async (c) => {
    const name = c.req.param('name');
    if (!SECRET_REF_RE.test(name)) throw fail('invalid_request', 'secret names look like <scope>/<name>, e.g. org/openai');
    const b = await body(c as unknown as C, z.object({ value: z.string().min(1) }));
    const org = orgParam(c);
    ctx.store.run('INSERT INTO org_secrets (org_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', org, name, b.value, now());
    return c.json({ org, name, updated_at: now() });
  });
  r.get('/feedback', (c) => c.json(listFeedback(ctx))); // agents' reports about the platform, newest first
  r.get('/secrets', (c) => c.json(orgSecretNames(ctx, orgParam(c))));
  r.delete('/secrets/:name{.+}', (c) => {
    ctx.store.run('DELETE FROM org_secrets WHERE org_id = ? AND name = ?', orgParam(c), c.req.param('name'));
    return c.body(null, 204);
  });
  return r;
}

/** Mounted under /v1/apps/:app (after App-key auth). */
export function appRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();

  r.get('/', (c) => {
    const app = c.get('app');
    return c.json({
      name: app.name,
      created_at: app.created_at,
      url: ctx.resources.appUrl(app.name, 'main'),
      envs: ctx.store.envs(app.id).map((e) => envSummary(ctx, app, e)),
      // What [auth].providers may list and actually work for this App right now (BoxLite's own
      // OAuth apps plus the App's own, set in the console); `init` writes these.
      sign_in_providers: appProviders(ctx, app),
    });
  });

  // ---- the App's own secrets (orgs.ts): values go in, never come back out ----
  /** Names only: the App's own (`app/…`) and its organization's, each usable as a [secrets] reference. */
  r.get('/secrets', (c) => {
    const app = c.get('app');
    return c.json({ app: appSecretNames(ctx, app.id), org: orgSecretNames(ctx, app.org_id ?? PLATFORM_ORG) });
  });
  r.put('/secrets/:name{.+}', async (c) => {
    const b = await body(c as unknown as C, z.object({ value: z.string() }));
    return c.json(setAppSecret(ctx, c.get('app'), c.req.param('name'), b.value, c.get('actor')));
  });
  r.delete('/secrets/:name{.+}', (c) => {
    deleteAppSecret(ctx, c.get('app'), c.req.param('name'), c.get('actor'));
    return c.body(null, 204);
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

  return r;
}
