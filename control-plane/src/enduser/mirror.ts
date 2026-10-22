/** Copies signed-in users into the app's own database (`boxlite.users`, `boxlite.current_user_id()`). */
import type { Ctx } from '../ctx.js';
import type { AppUser } from './sessions.js';

/** `boxlite.users` plus the RLS helper; idempotent. */
export const AUTH_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS boxlite',
  `CREATE TABLE IF NOT EXISTS boxlite.users (
    id uuid PRIMARY KEY,
    email text,
    name text,
    provider text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  )`,
  `CREATE OR REPLACE FUNCTION boxlite.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('boxlite.user_id', true), '')::uuid $$`,
];

const UPSERT_MIRROR = `INSERT INTO boxlite.users (id, email, name, provider, created_at, last_login_at) VALUES ($1, $2, $3, $4, now(), now())
  ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, provider = excluded.provider, last_login_at = now()`;

const mirrored = new WeakMap<object, Set<string>>();

export async function ensureUserMirror(ctx: Pick<Ctx, 'appdb'>, dbUrl: string): Promise<void> {
  await ctx.appdb.query(dbUrl, AUTH_SCHEMA_SQL, { write: true });
}

/** Copies the user into the env's database (when it has one). Login never fails because of it. */
export async function mirrorUser(ctx: Ctx, envId: string, user: AppUser): Promise<void> {
  const env = ctx.store.envById(envId);
  if (!env?.db_url || !ctx.resources.currentSpec(env)?.database) return;
  try {
    let done = mirrored.get(ctx);
    if (!done) mirrored.set(ctx, (done = new Set()));
    if (!done.has(env.id)) {
      await ensureUserMirror(ctx, env.db_url);
      done.add(env.id);
    }
    await ctx.appdb.query(env.db_url, [UPSERT_MIRROR], { write: true, params: [user.id, user.email, user.name, user.provider] });
  } catch (err) {
    console.error(`[auth] mirror user into ${env.name} database: ${(err as Error).message}`);
  }
}
