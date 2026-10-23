/** The access gate of an app origin: App key or admin token, public access, or the access cookie a one-time ticket sets. */
import { randomBytes } from 'node:crypto';
import { appForKey, bearer, safeEqual, sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { safeNext } from '../enduser/paths.js';
import { fail } from '../errors.js';
import { hostCookieName, isSecureUrl, readCookie, setCookieValue } from '../http/cookies.js';
import { escapeHtml } from '../http/html.js';
import { isResponse } from '../http/response.js';
import { signExpiring, verifyExpiring } from '../http/signed-token.js';
import { jsonError, page } from './pages.js';

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

/** A one-time link into the env's origin that sets its access cookie. Stored hashed, 60 s. */
export function createOpenTicket(ctx: Ctx, app: AppRow, env: EnvRow, next: string | null | undefined, actor: string): { url: string; expires_at: string } {
  const path = safeNext(next);
  if (path === null) throw fail('invalid_request', '`next` must be a path inside the app, like /deals?x=1');
  const ticket = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_S * 1000).toISOString();
  ctx.store.run('DELETE FROM open_tickets WHERE expires_at < ?', now());
  ctx.store.run('INSERT INTO open_tickets (hash, env_id, next, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sha256hex(ticket), env.id, path, actor, now(), expiresAt);
  return { url: `${ctx.resources.appUrl(app.name, env.name)}/.boxlite/open?t=${ticket}&next=${encodeURIComponent(path)}`, expires_at: expiresAt };
}

/** True once per ticket: the UPDATE only matches an unused, unexpired ticket of this env. */
function consumeTicket(ctx: Ctx, env: EnvRow, ticket: string): boolean {
  if (!ticket) return false;
  const ts = now();
  return Number(ctx.store.run('UPDATE open_tickets SET used_at = ? WHERE hash = ? AND env_id = ? AND used_at IS NULL AND expires_at > ?', ts, sha256hex(ticket), env.id, ts).changes) === 1;
}

export /** `/.boxlite/open?t=…`: a valid ticket sets the access cookie and redirects to `next`. */
function openWithTicket(ctx: Ctx, app: AppRow, env: EnvRow, url: URL): Response {
  const next = safeNext(url.searchParams.get('next')) ?? '/';
  const noRef = { 'referrer-policy': 'no-referrer' };
  if (!consumeTicket(ctx, env, url.searchParams.get('t') ?? '')) {
    return page(
      'Link expired',
      `<h1>This link has expired</h1><p>Links like this work once, within a minute. <a href="${escapeHtml(`${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}`)}">Open it again from your dashboard</a>.</p>`,
      401,
      noRef,
    );
  }
  const cookie = setCookieValue(isSecureUrl(ctx.resources.appUrl(app.name, env.name)), accessName(ctx, app, env), signAccess(ctx.config.sessionSecret, env.id), '/', ACCESS_TTL_S);
  return new Response(null, { status: 302, headers: { location: next, 'set-cookie': cookie, 'cache-control': 'no-store', ...noRef } });
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
 * admin token) passes and is stripped; otherwise a public env, or the access cookie of a ticket.
 */
export function accessGate(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers): Gate {
  const key = keyGate(ctx, app, headers);
  if (isResponse(key)) return { ok: false, refusal: key, access: 'private' };
  if (key === 'ok') return { ok: true, stripAuthorization: true };
  const access = ctx.resources.effectiveAccess(env);
  if (access === 'public' || verifyAccess(ctx.config.sessionSecret, readCookie(headers, accessName(ctx, app, env)), env.id)) return { ok: true, stripAuthorization: false };
  return { ok: false, refusal: null, access };
}
