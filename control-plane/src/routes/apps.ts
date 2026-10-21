import { SECRET_REF_RE } from '@microcloud/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { newAppKey, newId, newSecret, sha256hex, type Vars } from '../auth.js';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { nameProblem } from '../platform.js';
import { envSummary } from '../views.js';
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
    insertKey(ctx, appId, key);
    ctx.store.run('INSERT INTO envs (id, app_id, name, created_at, forward_secret) VALUES (?, ?, ?, ?, ?)', newId('env'), appId, 'main', now(), newSecret());
  });
  const app = ctx.store.appById(appId)!;
  ctx.store.recordActivity(app.id, null, actor, 'app.create', { name });
  return { app, key };
}

/** Only the key's sha256 and last 4 characters are kept. */
function insertKey(ctx: Ctx, appId: string, key: string): void {
  ctx.store.run('INSERT INTO keys (id, app_id, hash, last4, created_at) VALUES (?, ?, ?, ?, ?)', newId('key'), appId, sha256hex(key), key.slice(-4), now());
}

/** A new App key; the old one stops working at once. The new key exists in clear text only in the return value. */
export function rotateKey(ctx: Ctx, app: AppRow, actor: string): string {
  const key = newAppKey();
  ctx.store.tx(() => {
    ctx.store.run('UPDATE keys SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL', now(), app.id);
    insertKey(ctx, app.id, key);
  });
  ctx.store.recordActivity(app.id, null, actor, 'key.rotate');
  return key;
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
    if (!SECRET_REF_RE.test(name)) throw fail('invalid_request', 'secret names look like <scope>/<name>, e.g. org/openai');
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

  return r;
}
