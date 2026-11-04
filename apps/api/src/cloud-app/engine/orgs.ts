import type { Ctx } from './ctx'
import type { AppRow } from './db'
import { now } from './db'
import { fail } from './errors'
export type Viewer = {
  kind: 'user'
  user: { id: string; login: string | null; email: string | null; name: string | null }
  org: { id: string; name: string; app_limit: number | null; suspended_reason: string | null }
  role: 'owner' | 'member'
}
export function canSee(viewer: Viewer, app: AppRow): boolean {
  return app.org_id === viewer.org.id
}
export function orgIdFor(viewer: Viewer): string {
  return viewer.org.id
}
export async function secretValue(ctx: Pick<Ctx, 'store'>, app: AppRow, ref: string): Promise<string | undefined> {
  if (ref.startsWith(APP_SECRET_SCOPE))
    return (
      await ctx.store.get<{ value: string }>(
        'SELECT value FROM app_secrets WHERE app_id = ? AND name = ?',
        app.id,
        ref.slice(APP_SECRET_SCOPE.length),
      )
    )?.value
  return (
    await ctx.store.get<{ value: string }>(
      'SELECT value FROM org_secrets WHERE org_id = ? AND name = ?',
      app.org_id,
      ref,
    )
  )?.value
}

/** `app/<name>` references the App's own secret (set by its agent or in the console); any other scope, its organization's. */
export const APP_SECRET_SCOPE = 'app/'
/** The part after `app/`: what an App secret may be called. */
export const APP_SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Stores the App's own secret `app/<name>` (accepts the name with or without `app/`); the value is never logged. */
export async function setAppSecret(
  ctx: Pick<Ctx, 'store'>,
  app: AppRow,
  raw: string,
  value: string,
  actor: string,
): Promise<{ name: string; updated_at: string; created: boolean }> {
  const name = appSecretName(raw)
  if (!value) throw fail('invalid_request', 'the value is empty')
  if (value.length > 65_536) throw fail('invalid_request', 'the value is longer than 64 KB')
  const created = !(await ctx.store.get('SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?', app.id, name))
  const at = now()
  await ctx.store.run(
    'INSERT INTO app_secrets (app_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    app.id,
    name,
    value,
    at,
  )
  await ctx.store.recordActivity(app.id, null, actor, created ? 'secret.set' : 'secret.update', {
    name: APP_SECRET_SCOPE + name,
  })
  return { name: APP_SECRET_SCOPE + name, updated_at: at, created }
}

export async function deleteAppSecret(ctx: Pick<Ctx, 'store'>, app: AppRow, raw: string, actor: string): Promise<void> {
  const name = appSecretName(raw)
  if (!(await ctx.store.run('DELETE FROM app_secrets WHERE app_id = ? AND name = ?', app.id, name)).changes) {
    throw fail(
      'not_found',
      `no App secret ${APP_SECRET_SCOPE}${name}`,
      '`boxlite-app app secrets list` shows the names',
    )
  }
  await ctx.store.recordActivity(app.id, null, actor, 'secret.delete', { name: APP_SECRET_SCOPE + name })
}

function appSecretName(raw: string): string {
  const name = raw.startsWith(APP_SECRET_SCOPE) ? raw.slice(APP_SECRET_SCOPE.length) : raw
  if (!APP_SECRET_NAME_RE.test(name))
    throw fail(
      'invalid_request',
      `"${raw}" is not a secret name`,
      'use letters, digits, ".", "_" or "-", e.g. `stripe` (referenced as app/stripe)',
    )
  return name
}

/** The App's own secret names (never values), as `app/<name>` references. */
export async function appSecretNames(
  ctx: Pick<Ctx, 'store'>,
  appId: string,
): Promise<{ name: string; updated_at: string }[]> {
  return (
    await ctx.store.all<{ name: string; updated_at: string }>(
      'SELECT name, updated_at FROM app_secrets WHERE app_id = ? ORDER BY name',
      appId,
    )
  ).map((r) => ({ name: APP_SECRET_SCOPE + r.name, updated_at: r.updated_at }))
}

/** The secret names of one org, for the console's "Reference a secret". */
export async function orgSecretNames(
  ctx: Pick<Ctx, 'store'>,
  orgId: string,
): Promise<{ name: string; updated_at: string }[]> {
  return await ctx.store.all<{ name: string; updated_at: string }>(
    'SELECT name, updated_at FROM org_secrets WHERE org_id = ? ORDER BY name',
    orgId,
  )
}
