import type { Ctx } from './ctx.js';
import type { AppRow } from './db.js';
import { ACTIVE_STATUSES, now } from './db.js';
import { fail } from './errors.js';

/**
 * App deletion (PRD 3.13). Deleting is soft: keys stop working and the URL says the App is
 * gone, but Boxes, volumes, the database and the name are kept for RETENTION_DAYS so a mistake
 * can be undone. The purger then removes every resource for real.
 */
export const RETENTION_DAYS = 7;
const PURGE_EVERY_MS = 10 * 60_000;

function assertIdle(ctx: Ctx, app: AppRow): void {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  for (const env of ctx.store.envs(app.id)) {
    if (ctx.store.deploymentsWhere(`env_id = ? AND status IN (${placeholders})`, env.id, ...ACTIVE_STATUSES).length) {
      throw fail('conflict', `environment "${env.name}" has a deployment in progress`, 'wait for it to finish or cancel it, then delete');
    }
  }
}

export async function deleteApp(ctx: Ctx, app: AppRow, actor: string): Promise<{ deleted_at: string; purge_after: string }> {
  if (app.deleted_at) return { deleted_at: app.deleted_at, purge_after: app.purge_after! };
  assertIdle(ctx, app);
  const at = now();
  const purgeAfter = new Date(Date.now() + RETENTION_DAYS * 86_400_000).toISOString();
  // Keys revoked by the delete carry its timestamp, so restore re-enables exactly those keys.
  ctx.store.tx(() => {
    ctx.store.run('UPDATE keys SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL', at, app.id);
    ctx.store.run('UPDATE apps SET deleted_at = ?, purge_after = ? WHERE id = ?', at, purgeAfter, app.id);
  });
  for (const env of ctx.store.envs(app.id)) {
    if (env.box_id) await ctx.boxlite.stopBox(env.box_id).catch((err) => console.error(`[lifecycle] stop ${env.box_id}: ${(err as Error).message}`));
  }
  ctx.store.recordActivity(app.id, null, actor, 'app.delete', { purge_after: purgeAfter });
  return { deleted_at: at, purge_after: purgeAfter };
}

export function restoreApp(ctx: Ctx, app: AppRow, actor: string): void {
  if (!app.deleted_at) return;
  ctx.store.tx(() => {
    ctx.store.run('UPDATE keys SET revoked_at = NULL WHERE app_id = ? AND revoked_at = ?', app.id, app.deleted_at ?? null);
    ctx.store.run('UPDATE apps SET deleted_at = NULL, purge_after = NULL WHERE id = ?', app.id);
  });
  // Boxes stay stopped; the first request wakes them like any idle App.
  ctx.store.recordActivity(app.id, null, actor, 'app.restore');
}

/** Removes every resource of the App, then its rows. Safe to re-run after a partial failure. */
export async function purgeApp(ctx: Ctx, app: AppRow): Promise<void> {
  assertIdle(ctx, app);
  const { store } = ctx;
  const envs = store.envs(app.id);
  for (const env of envs) {
    if (env.box_id) await ctx.boxlite.deleteBox(env.box_id);
    await ctx.resources.deleteVolumes(app, env);
  }
  if (app.neon_project_id) await ctx.neon.deleteProject(app.neon_project_id);
  store.tx(() => {
    for (const env of envs) {
      store.run('DELETE FROM deployment_events WHERE env_id = ?', env.id);
      store.run('DELETE FROM logs WHERE env_id = ?', env.id);
    }
    store.run('DELETE FROM activity WHERE app_id = ?', app.id);
    store.run('DELETE FROM apps WHERE id = ?', app.id);
  });
  console.log(`[lifecycle] purged app ${app.name}`);
}

export async function purgeExpired(ctx: Ctx, at = new Date()): Promise<string[]> {
  const due = ctx.store.all<AppRow>('SELECT * FROM apps WHERE deleted_at IS NOT NULL AND purge_after <= ?', at.toISOString());
  const done: string[] = [];
  for (const app of due) {
    try {
      await purgeApp(ctx, app);
      done.push(app.name);
    } catch (err) {
      console.error(`[lifecycle] purge ${app.name}: ${(err as Error).message}`);
    }
  }
  return done;
}

export function startPurger(ctx: Ctx): () => void {
  const timer = setInterval(() => void purgeExpired(ctx), PURGE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
