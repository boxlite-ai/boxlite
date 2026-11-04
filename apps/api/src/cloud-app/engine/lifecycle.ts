import type { Ctx } from './ctx'
import type { AppRow } from './db'
import { ACTIVE_STATUSES, now } from './db'
import { fail } from './errors'

/**
 * App deletion (PRD 3.13). Deleting is soft: keys stop working and the URL says the App is
 * gone, but Boxes, volumes, the database and the name are kept for RETENTION_DAYS so a mistake
 * can be undone. The purger then removes every resource for real.
 */
export const RETENTION_DAYS = 7
const PURGE_EVERY_MS = 10 * 60_000

async function assertIdle(ctx: Ctx, app: AppRow): Promise<void> {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
  for (const env of await ctx.store.envs(app.id)) {
    if (
      (await ctx.store.deploymentsWhere(`env_id = ? AND status IN (${placeholders})`, env.id, ...ACTIVE_STATUSES))
        .length
    ) {
      throw fail(
        'conflict',
        `environment "${env.name}" has a deployment in progress`,
        'wait for it to finish or cancel it, then delete',
      )
    }
  }
}

export async function deleteApp(
  ctx: Ctx,
  app: AppRow,
  actor: string,
): Promise<{ deleted_at: string; purge_after: string }> {
  if (app.deleted_at) return { deleted_at: app.deleted_at, purge_after: app.purge_after! }
  await assertIdle(ctx, app)
  const at = now()
  const purgeAfter = new Date(Date.now() + RETENTION_DAYS * 86_400_000).toISOString()
  await ctx.store.tx(async () => {
    await ctx.store.run('UPDATE apps SET deleted_at = ?, purge_after = ? WHERE id = ?', at, purgeAfter, app.id)
  })
  for (const env of await ctx.store.envs(app.id)) {
    if (env.box_id)
      await ctx.resources
        .sleep(env.box_id)
        .catch((err) => console.error(`[lifecycle] stop ${env.box_id}: ${(err as Error).message}`))
  }
  await ctx.store.recordActivity(app.id, null, actor, 'app.delete', { purge_after: purgeAfter })
  return { deleted_at: at, purge_after: purgeAfter }
}

export async function restoreApp(ctx: Ctx, app: AppRow, actor: string): Promise<void> {
  if (!app.deleted_at) return
  await ctx.store.tx(async () => {
    await ctx.store.run('UPDATE apps SET deleted_at = NULL, purge_after = NULL WHERE id = ?', app.id)
  })
  // Boxes stay stopped; the first request wakes them like any idle App.
  await ctx.store.recordActivity(app.id, null, actor, 'app.restore')
}

/** Removes every resource of the App, then its rows. Safe to re-run after a partial failure. */
export async function purgeApp(ctx: Ctx, app: AppRow): Promise<void> {
  await assertIdle(ctx, app)
  const { store } = ctx
  const envs = await store.envs(app.id)
  for (const env of envs) {
    if (env.box_id) await ctx.boxlite.deleteBox(env.box_id)
    await ctx.resources.deleteVolumes(app, env)
    await ctx.domains.releaseEnvironment(app, env)
  }
  if (app.neon_project_id) await ctx.neon.deleteProject(app.neon_project_id)
  for (const key of await ctx.credentials.list(app)) await ctx.credentials.revoke(app, key.id, 'worker')
  await ctx.blobs.deleteApp(app.id)
  await store.tx(async () => {
    for (const env of envs) {
      await store.run('DELETE FROM deployment_events WHERE env_id = ?', env.id)
      await store.run('DELETE FROM logs WHERE env_id = ?', env.id)
    }
    await store.run('DELETE FROM activity WHERE app_id = ?', app.id)
    if (app.neon_project_id) await store.run('DELETE FROM db_readers WHERE project_id = ?', app.neon_project_id)
    await store.run('DELETE FROM apps WHERE id = ?', app.id)
  })
  console.log(`[lifecycle] purged app ${app.name}`)
}

export async function purgeExpired(ctx: Ctx, at = new Date()): Promise<string[]> {
  const due = await ctx.store.all<AppRow>(
    'SELECT * FROM apps WHERE deleted_at IS NOT NULL AND purge_after <= ? AND (?::uuid IS NULL OR org_id = ?::uuid)',
    at.toISOString(),
    ctx.store.organizationId ?? null,
    ctx.store.organizationId ?? null,
  )
  const done: string[] = []
  for (const app of due) {
    try {
      await purgeApp(ctx, app)
      done.push(app.name)
    } catch (err) {
      console.error(`[lifecycle] purge ${app.name}: ${(err as Error).message}`)
    }
  }
  return done
}

export function startPurger(ctx: Ctx): () => void {
  const timer = setInterval(async () => void (await purgeExpired(ctx)), PURGE_EVERY_MS)
  timer.unref()
  return () => clearInterval(timer)
}
