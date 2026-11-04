/** Creating an App (row, key, `main` env) and rotating its key; called by the admin API and the console. */
import { principalStorage } from '../platform-principal'
import { newId, newSecret } from '../auth'
import type { AppRow } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { fail } from '../errors'
import { nameProblem } from '../platform'

/** Creates the app row, its key and the `main` env. Neon and the Box are created lazily. */
/** App names are unique within their platform organization. */
export async function createApp(
  ctx: Ctx,
  name: string,
  actor = 'admin',
  orgId = ctx.store.organizationId ?? principalStorage.getStore()?.organizationId,
): Promise<{ app: AppRow; key: string }> {
  const problem = nameProblem(name)
  if (problem) throw fail('invalid_request', `app name "${name}" ${problem}`)
  if (await ctx.store.appByName(name)) throw fail('conflict', `an app named "${name}" already exists`)
  const deleted = await ctx.store.appByNameAnyState(name)
  if (deleted?.deleted_at) {
    // A date people read (the console shows this message as is); the exact time stays in Recently deleted.
    const until = deleted.purge_after
      ? new Date(deleted.purge_after).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : 'its purge'
    throw fail(
      'conflict',
      `"${name}" belongs to a deleted app that is kept until ${until}`,
      'restore it from Recently deleted, or pick another name',
    )
  }
  if (!orgId) throw fail('forbidden', 'organization required')
  const appId = newId('app')
  await ctx.store.tx(async () => {
    await ctx.store.run(
      'INSERT INTO apps (id, name, created_at, org_id) VALUES (?, ?, ?, ?)',
      appId,
      name,
      now(),
      orgId,
    )

    await ctx.store.run(
      'INSERT INTO envs (id, app_id, name, created_at, forward_secret, control_secret) VALUES (?, ?, ?, ?, ?, ?)',
      newId('env'),
      appId,
      'main',
      now(),
      newSecret(),
      newSecret(),
    )
  })
  const app = (await ctx.store.appById(appId))!
  await ctx.store.recordActivity(app.id, null, actor, 'app.create', { name })
  try {
    return { app, key: await ctx.credentials.issue(app, actor) }
  } catch (error) {
    await ctx.store.run('DELETE FROM apps WHERE id = ?', app.id)
    throw error
  }
}

export async function issueKey(ctx: Ctx, app: AppRow, actor: string): Promise<string> {
  return await ctx.credentials.issue(app, actor)
}
export async function rotateKey(ctx: Ctx, app: AppRow, actor: string): Promise<string> {
  return await ctx.credentials.rotate(app, actor)
}
export async function listKeys(ctx: Ctx, app: AppRow) {
  return await ctx.credentials.list(app)
}
export async function revokeKey(ctx: Ctx, app: AppRow, keyId: string, actor: string): Promise<void> {
  return await ctx.credentials.revoke(app, keyId, actor)
}
