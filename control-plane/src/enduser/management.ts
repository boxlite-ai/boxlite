/** Managing an env's end users, for the CLI routes and the console: status, list, sign out, block, CSV export, test sessions. */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { OAUTH_PROVIDERS } from '../oauth-providers.js';
import { TEST_SESSION_TTL_S, configuredProviders, redirectUri, sessionName } from './config.js';
import { mirrorUser } from './mirror.js';
import { createSession, revokeSessions, upsertUser, userById, view, type AppUser, type UserView } from './sessions.js';

export interface AuthStatus {
  enabled: boolean;
  providers: { name: string; status: 'ready' | 'not_configured' }[];
  protect: string[];
  login_url: string;
  users: number;
}

export function authStatus(ctx: Ctx, app: AppRow, env: EnvRow): AuthStatus {
  const auth = ctx.resources.currentSpec(env)?.auth ?? null;
  const ready = configuredProviders(ctx);
  return {
    enabled: auth !== null,
    providers: (auth?.providers ?? []).map((name) => ({ name, status: ready.includes(name) ? 'ready' : 'not_configured' })),
    protect: auth?.protect ?? [],
    login_url: `${ctx.resources.appUrl(app.name, env.name)}/.boxlite/auth/login`,
    users: ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_users WHERE env_id = ?', env.id)?.n ?? 0,
  };
}

export function redirectUris(ctx: Ctx): { provider: string; redirect_uri: string; status: 'ready' | 'not_configured' }[] {
  const ready = configuredProviders(ctx);
  return Object.keys(OAUTH_PROVIDERS).map((p) => ({ provider: p, redirect_uri: redirectUri(ctx, p), status: ready.includes(p) ? 'ready' : 'not_configured' }));
}

export function listUsers(ctx: Ctx, _app: AppRow, env: EnvRow, opts: { search?: string; limit?: number } = {}): UserView[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 10_000);
  const rows = opts.search
    ? ctx.store.all<AppUser>(
        "SELECT * FROM app_users WHERE env_id = ? AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY last_seen DESC LIMIT ?",
        env.id,
        `%${opts.search.replace(/[\\%_]/g, '\\$&')}%`,
        `%${opts.search.replace(/[\\%_]/g, '\\$&')}%`,
        limit,
      )
    : ctx.store.all<AppUser>('SELECT * FROM app_users WHERE env_id = ? ORDER BY last_seen DESC LIMIT ?', env.id, limit);
  return rows.map((u) => view(ctx, u));
}

export function signOutUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView & { revoked: number } {
  const u = userById(ctx, env, userId);
  const revoked = revokeSessions(ctx, u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.signout', { user: u.id, email: u.email, revoked });
  return { ...view(ctx, u), revoked };
}

export function blockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView {
  const u = userById(ctx, env, userId);
  ctx.store.run('UPDATE app_users SET blocked = 1 WHERE id = ?', u.id);
  revokeSessions(ctx, u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.block', { user: u.id, email: u.email });
  return view(ctx, userById(ctx, env, userId));
}

export function unblockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView {
  const u = userById(ctx, env, userId);
  ctx.store.run('UPDATE app_users SET blocked = 0 WHERE id = ?', u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.unblock', { user: u.id, email: u.email });
  return view(ctx, userById(ctx, env, userId));
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheets run cells starting with these as formulas; names come from end users.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportUsersCsv(ctx: Ctx, app: AppRow, env: EnvRow): string {
  const cols = ['id', 'email', 'name', 'provider', 'first_seen', 'last_seen', 'blocked'] as const;
  const rows = listUsers(ctx, app, env, { limit: 10_000 }).map((u) => cols.map((c) => csvCell(u[c])).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

/** A signed-in session for a `test` user, so an agent can exercise login-only pages with curl. */
export async function createTestSession(ctx: Ctx, app: AppRow, env: EnvRow, email: string, actor: string): Promise<{ cookie: string; cookie_name: string; expires_in: string; expires_at: string; user: UserView }> {
  if (!ctx.resources.currentSpec(env)?.auth) throw fail('conflict', `sign-in is not enabled for ${app.name}/${env.name}`, 'add [auth] to boxlite.toml, then `boxlite-app apply --yes`');
  const normal = email.trim().toLowerCase();
  const user = upsertUser(ctx, app, env, 'test', { id: normal, email: normal, name: normal.split('@')[0] ?? normal, avatarUrl: null });
  if (user.blocked) throw fail('forbidden', `${normal} is blocked in ${env.name}`, 'unblock it with `boxlite-app app auth users unblock <email>`');
  const { token, expiresAt } = createSession(ctx, user, 'test', TEST_SESSION_TTL_S);
  await mirrorUser(ctx, env.id, user);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.test_session', { user: user.id, email: normal });
  // For the app's own origin (BOXLITE_APP_URL); host-only there, like a real sign-in.
  const name = sessionName(ctx, app, env);
  return { cookie: `${name}=${token}`, cookie_name: name, expires_in: '15m', expires_at: expiresAt, user: view(ctx, user) };
}
