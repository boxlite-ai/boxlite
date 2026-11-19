import type { Ctx } from './ctx'
import type { AppRow } from './db'
import { ACTIVE_STATUSES, now } from './db'
import { fail } from './errors'

/**
 * App deletion (PRD 3.13). Deleting is soft: management and public URLs stop serving the App,
 * but Boxes, volumes, the database and the name are kept for RETENTION_DAYS so a mistake
 * can be undone. The purger then removes every resource for real.
 */
export const RETENTION_DAYS = 7
const PURGE_EVERY_MS = 10 * 60_000

async function lockedApp(ctx: Ctx, app: AppRow): Promise<AppRow | undefined> {
  return ctx.store.get<AppRow>(
    'SELECT * FROM apps WHERE id = ? AND org_id = ? FOR UPDATE',
    app.id,
    ctx.store.organizationId ?? app.org_id,
  )
}

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
  const { deleted, newlyDeleted } = await ctx.store.tx(async () => {
    const current = await lockedApp(ctx, app)
    if (!current) throw fail('not_found_app', `no app named "${app.name}"`)
    if (current.deleted_at)
      return { deleted: { deleted_at: current.deleted_at, purge_after: current.purge_after! }, newlyDeleted: false }
    await assertIdle(ctx, current)
    const at = now()
    const purgeAfter = new Date(Date.now() + RETENTION_DAYS * 86_400_000).toISOString()
    await ctx.store.run('UPDATE apps SET deleted_at = ?, purge_after = ? WHERE id = ?', at, purgeAfter, app.id)
    await ctx.store.recordActivity(app.id, null, actor, 'app.delete', { purge_after: purgeAfter })
    return { deleted: { deleted_at: at, purge_after: purgeAfter }, newlyDeleted: true }
  })
  if (!newlyDeleted) return deleted
  for (const boxId of await ctx.boxes.list(app)) {
    await ctx.resources
      .sleep(boxId)
      .catch((err) => console.error(`[lifecycle] stop ${boxId}: ${(err as Error).message}`))
  }
  return deleted
}

export async function restoreApp(ctx: Ctx, app: AppRow, actor: string): Promise<void> {
  await ctx.store.tx(async () => {
    const current = await lockedApp(ctx, app)
    if (!current) throw fail('not_found_app', `no app named "${app.name}"`)
    if (!current.deleted_at) return
    const restored = await ctx.store.run(
      'UPDATE apps SET deleted_at = NULL, purge_after = NULL WHERE id = ? AND purge_after > clock_timestamp()',
      app.id,
    )
    if (!restored.changes)
      throw fail('conflict', 'App retention has ended or permanent deletion has started', 'create a new App')
    await ctx.store.recordActivity(app.id, null, actor, 'app.restore')
  })
  // Boxes stay stopped; the first request wakes them like any idle App.
}

/** Removes every resource of the App, then its rows. Safe to re-run after a partial failure. */
export async function purgeApp(
  ctx: Ctx,
  app: AppRow,
  options: { deletedOnly?: boolean; dueAt?: string } = {},
): Promise<boolean> {
  return ctx.withPurgeLock(app.id, async (signal) => {
    const { store } = ctx
    signal.throwIfAborted()
    const committed = await store.tx(async () => {
      const current = await lockedApp(ctx, app)
      if (!current) {
        if (options.dueAt) return undefined
        throw fail('not_found_app', `no app named "${app.name}"`)
      }
      if (options.deletedOnly && !current.deleted_at) throw fail('not_found_app', `no deleted app named "${app.name}"`)
      // A worker's candidate may have been restored since its scan.
      if (options.dueAt && (!current.deleted_at || !current.purge_after || current.purge_after > options.dueAt))
        return undefined
      await assertIdle(ctx, current)
      signal.throwIfAborted()
      // Commit the irreversible boundary before any remote deletion. Failed cleanup remains due for retry.
      await store.run(
        'UPDATE apps SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), purge_after = LEAST(COALESCE(purge_after, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP) WHERE id = ?',
        app.id,
      )
      return current
    })
    if (!committed) return false
    const envs = await store.envs(app.id)
    for (const boxId of await ctx.boxes.list(committed)) {
      signal.throwIfAborted()
      await ctx.boxlite.deleteBox(boxId)
    }
    for (const env of envs) {
      signal.throwIfAborted()
      await ctx.resources.deleteVolumes(committed, env)
      signal.throwIfAborted()
      await ctx.domains.releaseEnvironment(committed, env)
    }
    signal.throwIfAborted()
    if (committed.neon_project_id) await ctx.neon.deleteProject(committed.neon_project_id)
    signal.throwIfAborted()
    await ctx.blobs.deleteApp(app.id)
    signal.throwIfAborted()
    await store.tx(async () => {
      for (const env of envs) {
        await store.run('DELETE FROM deployment_events WHERE env_id = ?', env.id)
        await store.run('DELETE FROM logs WHERE env_id = ?', env.id)
      }
      await store.run('DELETE FROM activity WHERE app_id = ?', app.id)
      if (committed.neon_project_id)
        await store.run('DELETE FROM db_readers WHERE project_id = ?', committed.neon_project_id)
      signal.throwIfAborted()
      await store.run('DELETE FROM apps WHERE id = ?', app.id)
    })
    console.log(`[lifecycle] purged app ${app.name}`)
    return true
  })
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
      if (await purgeApp(ctx, app, { dueAt: at.toISOString() })) done.push(app.name)
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
