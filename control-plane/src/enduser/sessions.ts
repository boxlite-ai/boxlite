/** The user pool and server-side sessions of an app env (sqlite `app_users`, `app_sessions`). */
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import type { OAuthProfile } from '../oauth-providers.js';
import { SESSION_TTL_S, SLIDE_EVERY_MS } from './config.js';

export interface AppUser {
  id: string;
  app_id: string;
  env_id: string;
  provider: string;
  provider_user_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  first_seen: string;
  last_seen: string;
  blocked: number;
  /** Test users only: the role they were created with (role.ts). */
  test_role?: string | null;
}

export interface UserView {
  id: string;
  email: string | null;
  name: string | null;
  provider: string;
  avatar_url: string | null;
  first_seen: string;
  last_seen: string;
  blocked: boolean;
  active_sessions: number;
}

export function upsertUser(ctx: Ctx, app: AppRow, env: EnvRow, provider: string, p: OAuthProfile): AppUser {
  const ts = now();
  ctx.store.run(
    `INSERT INTO app_users (id, app_id, env_id, provider, provider_user_id, email, name, avatar_url, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (env_id, provider, provider_user_id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, last_seen = excluded.last_seen`,
    randomUUID(),
    app.id,
    env.id,
    provider,
    p.id,
    p.email,
    p.name,
    p.avatarUrl,
    ts,
    ts,
  );
  return ctx.store.get<AppUser>('SELECT * FROM app_users WHERE env_id = ? AND provider = ? AND provider_user_id = ?', env.id, provider, p.id)!;
}

export function createSession(ctx: Ctx, user: AppUser, kind: 'oauth' | 'test', ttlSeconds: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  ctx.store.run(
    'INSERT INTO app_sessions (token_hash, user_id, app_id, env_id, kind, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256hex(token),
    user.id,
    user.app_id,
    user.env_id,
    kind,
    ts,
    ts,
    expiresAt,
  );
  return { token, expiresAt };
}

export function revokeSessions(ctx: Ctx, userId: string): number {
  return Number(ctx.store.run('UPDATE app_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId).changes);
}

/** The signed-in user for a session token, sliding the expiry; blocked users lose their sessions. */
export function sessionUser(ctx: Ctx, env: EnvRow, token: string | undefined): AppUser | null {
  if (!token) return null;
  const row = ctx.store.get<AppUser & { token_hash: string; kind: string; s_last_seen: string }>(
    `SELECT u.*, s.token_hash, s.kind, s.last_seen AS s_last_seen FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.env_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    sha256hex(token),
    env.id,
    now(),
  );
  if (!row) return null;
  if (row.blocked) {
    revokeSessions(ctx, row.id);
    return null;
  }
  if (Date.now() - Date.parse(row.s_last_seen) > SLIDE_EVERY_MS) {
    const ts = now();
    // Test sessions keep their fixed 15 minutes.
    if (row.kind === 'test') ctx.store.run('UPDATE app_sessions SET last_seen = ? WHERE token_hash = ?', ts, row.token_hash);
    else ctx.store.run('UPDATE app_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', ts, new Date(Date.now() + SESSION_TTL_S * 1000).toISOString(), row.token_hash);
    ctx.store.run('UPDATE app_users SET last_seen = ? WHERE id = ?', ts, row.id);
  }
  const { token_hash: _t, kind: _k, s_last_seen: _s, ...user } = row;
  return user;
}

export function userById(ctx: Ctx, env: EnvRow, id: string): AppUser {
  const u = ctx.store.get<AppUser>('SELECT * FROM app_users WHERE id = ? AND env_id = ?', id, env.id);
  if (!u) throw fail('not_found', `no user ${id} in ${env.name}`, 'list users with `boxlite-app app auth users`');
  return u;
}

export function view(ctx: Ctx, u: AppUser): UserView {
  const active = ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', u.id, now())?.n ?? 0;
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, avatar_url: u.avatar_url, first_seen: u.first_seen, last_seen: u.last_seen, blocked: Boolean(u.blocked), active_sessions: active };
}
