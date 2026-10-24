/** The access gate of an app origin: App key or admin token, public access, or the access cookie a one-time ticket sets. */
import { randomBytes } from 'node:crypto';
import { appForKey, bearer, safeEqual, sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { isPublicPath, safeNext } from '../enduser/paths.js';
import { fail } from '../errors.js';
import { hostCookieName, isSecureUrl, readCookie, setCookieValue } from '../http/cookies.js';
import { escapeHtml } from '../http/html.js';
import { isResponse } from '../http/response.js';
import { signExpiring, verifyExpiring } from '../http/signed-token.js';
import { jsonError, page } from './pages.js';
import { TEST_SESSION_TTL_S } from '../enduser/config.js';
import { createTestSession } from '../enduser/management.js';
import type { EndUserRole } from '../enduser/role.js';

/**
 * The access gate of an app origin, for private/org envs (security review F7, no App key in URLs):
 *   - cookie `bxl_access` (host-only), set by `/.boxlite/open?t=<ticket>`; tickets come from
 *     `POST /v1/apps/:app/envs/:env/open-ticket` (App key) or the console, live 60 s, single use;
 *   - `Authorization: Bearer bxl_app_…` of this app: passes, and the header is stripped. Another
 *     app's key → 401 without forwarding. Other Authorization headers belong to the app.
 */

const ACCESS_COOKIE = 'bxl_access';
const accessName = (ctx: Ctx, app: AppRow, env: EnvRow) => hostCookieName(ACCESS_COOKIE, isSecureUrl(ctx.resources.appUrl(app.name, env.name)));
const TICKET_TTL_S = 60;
const ACCESS_TTL_S = 7 * 24 * 3600;

// ---- access cookie and tickets --------------------------------------------------

/** `<env id>.<expiry>.<hmac>`: bound to the env id, so a recycled port's old cookies open nothing. */
export function signAccess(secret: string, envId: string, ttlSeconds = ACCESS_TTL_S): string {
  return signExpiring(secret, 'app-access', envId, ttlSeconds, '.');
}

function verifyAccess(secret: string, value: string | undefined, envId: string): boolean {
  return verifyExpiring(secret, 'app-access', value, '.') === envId;
}

/**
 * A one-time link into the env's origin that sets its access cookie. Stored hashed, 60 s. With `as`,
 * opening it also signs the browser in as that test user (a 15-minute test session, made when the
 * link is opened, so no session token is ever stored or put in the link).
 */
export function createOpenTicket(ctx: Ctx, app: AppRow, env: EnvRow, next: string | null | undefined, actor: string, as?: { email: string; role: EndUserRole }): { url: string; expires_at: string } {
  const path = safeNext(next);
  if (path === null) throw fail('invalid_request', '`next` must be a path inside the app, like /deals?x=1');
  const ticket = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_S * 1000).toISOString();
  ctx.store.run('DELETE FROM open_tickets WHERE expires_at < ?', now());
  if (as && !ctx.resources.currentSpec(env)?.auth) throw fail('conflict', `sign-in is not enabled for ${app.name}/${env.name}`, 'add [auth] to boxlite.toml and deploy, or open without --as');
  ctx.store.run('INSERT INTO open_tickets (hash, env_id, next, created_by, created_at, expires_at, as_email, as_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sha256hex(ticket), env.id, path, actor, now(), expiresAt, as?.email ?? null, as?.role ?? null);
  return { url: `${ctx.resources.appUrl(app.name, env.name)}/.boxlite/open?t=${ticket}&next=${encodeURIComponent(path)}`, expires_at: expiresAt };
}

/** Once per ticket: the UPDATE only matches an unused, unexpired ticket of this env. Null when it did not. */
function consumeTicket(ctx: Ctx, env: EnvRow, ticket: string): { as_email: string | null; as_role: string | null; created_by: string } | null {
  if (!ticket) return null;
  const ts = now();
  const hash = sha256hex(ticket);
  if (Number(ctx.store.run('UPDATE open_tickets SET used_at = ? WHERE hash = ? AND env_id = ? AND used_at IS NULL AND expires_at > ?', ts, hash, env.id, ts).changes) !== 1) return null;
  return ctx.store.get('SELECT as_email, as_role, created_by FROM open_tickets WHERE hash = ?', hash) ?? null;
}

export /** `/.boxlite/open?t=…`: a valid ticket sets the access cookie (and a test session, with --as) and redirects to `next`. */
async function openWithTicket(ctx: Ctx, app: AppRow, env: EnvRow, url: URL): Promise<Response> {
  const next = safeNext(url.searchParams.get('next')) ?? '/';
  const noRef = { 'referrer-policy': 'no-referrer' };
  const ticket = consumeTicket(ctx, env, url.searchParams.get('t') ?? '');
  if (!ticket) {
    return page(
      'Link expired',
      `<h1>This link has expired</h1><p>Links like this work once, within a minute. <a href="${escapeHtml(`${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}`)}">Open it again from your dashboard</a>.</p>`,
      401,
      noRef,
    );
  }
  const secure = isSecureUrl(ctx.resources.appUrl(app.name, env.name));
  const headers = new Headers({ location: next, 'cache-control': 'no-store', ...noRef });
  headers.append('set-cookie', setCookieValue(secure, accessName(ctx, app, env), signAccess(ctx.config.sessionSecret, env.id), '/', ACCESS_TTL_S));
  if (ticket.as_email) {
    const s = await createTestSession(ctx, app, env, ticket.as_email, ticket.created_by, ticket.as_role === 'owner' ? 'owner' : 'user');
    headers.append('set-cookie', setCookieValue(secure, s.cookie_name, s.cookie.slice(s.cookie_name.length + 1), '/', TEST_SESSION_TTL_S));
  }
  return new Response(null, { status: 302, headers });
}

// ---- the gate --------------------------------------------------------------------

/** `Authorization` on an app origin: `none` (absent or the app's own scheme), `ok` (strip it), or a 401. */
function keyGate(ctx: Ctx, app: AppRow, headers: Headers): 'none' | 'ok' | Response {
  const token = bearer(headers.get('authorization') ?? undefined);
  if (!token) return 'none';
  // The admin token opens every app, and must never reach app code either.
  if (safeEqual(token, ctx.config.adminToken)) return 'ok';
  if (!token.startsWith('bxl_app_')) return 'none';
  if (appForKey(ctx.store, token)?.app.id === app.id) return 'ok';
  return jsonError(401, 'unauthenticated', `that App key does not open ${app.name}`, `use the key of ${app.name}; each App key opens only its own app`);
}

type Gate = { ok: true; stripAuthorization: boolean } | { ok: false; refusal: Response | null; access: string };

/**
 * The access gate of an app origin (F7), for HTTP and WebSocket alike: this app's key (or the
 * admin token) passes and is stripped; otherwise a public env, one of its `public_paths` (a
 * webhook), or the access cookie of a ticket.
 */
export function accessGate(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers, path: string): Gate {
  const key = keyGate(ctx, app, headers);
  if (isResponse(key)) return { ok: false, refusal: key, access: 'private' };
  if (key === 'ok') return { ok: true, stripAuthorization: true };
  const access = ctx.resources.effectiveAccess(env);
  if (isPublicPath(ctx.resources.currentSpec(env)?.public_paths ?? [], path)) return { ok: true, stripAuthorization: false };
  if (access === 'public' || verifyAccess(ctx.config.sessionSecret, readCookie(headers, accessName(ctx, app, env)), env.id)) return { ok: true, stripAuthorization: false };
  return { ok: false, refusal: null, access };
}
