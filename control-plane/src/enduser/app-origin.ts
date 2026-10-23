/** Sign-in on an app origin: the proxy hook (`identityFor`), `[auth].protect`, and `/.boxlite/auth/*`. */
import { randomBytes } from 'node:crypto';
import { safeEqual, sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { hostCookieName, readCookie, setCookieValue } from '../http/cookies.js';
import { escapeHtml } from '../http/html.js';
import { OAUTH_PROVIDERS } from '../oauth-providers.js';
import { AUTH_PATH, SESSION_COOKIE_MAX_AGE_S, SESSION_COOKIE_NAME, SESSION_TTL_S, STATE_TTL_S, appSecure, loginNonceName, oauthClientFor, sessionName } from './config.js';
import { identityToken, jwksResponse } from './identity.js';
import { authLog } from './oauth-flow.js';
import { htmlPage, noAccessPage, redirect, unauthenticated, wantsHtml } from './pages.js';
import { isProtected, normalisePath, safeNext } from './paths.js';
import { roleOf } from './role.js';
import { createSession, sessionUser, type AppUser } from './sessions.js';

export interface ProxyRequest {
  method: string;
  url: URL;
  headers: Headers;
}

/**
 * Called by the app origin after its access gate, for every request. Answers the
 * `/.boxlite/auth/*` routes itself, enforces `[auth].protect`, and otherwise returns the identity
 * headers to send upstream (none when signed out or when the app has no `[auth]`).
 */
export function identityFor(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow): Response | { headers: Record<string, string> } | Promise<Response> {
  const path = req.url.pathname || '/';
  const auth = ctx.resources.currentSpec(env)?.auth ?? null;
  if (path.startsWith('/.boxlite/auth/')) {
    if (!auth) return htmlPage('Sign-in is off', `<h1>Sign-in is not enabled for ${escapeHtml(app.name)}</h1><p>Add <code>[auth]</code> to <code>boxlite.toml</code> and deploy.</p>`, 404);
    return authRoute(ctx, req, app, env, path.slice('/.boxlite/auth'.length), auth.providers);
  }
  // The supervisor serves its control API (/.boxlite/sv/*) to the CP, so no end-user request may
  // reach /.boxlite/ upstream, however it is spelled.
  if (normalisePath(path).toLowerCase().startsWith('/.boxlite/') || normalisePath(path).toLowerCase() === '/.boxlite') return htmlPage('Not found', '<h1>Not found</h1>', 404);
  if (!auth) return { headers: {} };
  const user = sessionUser(ctx, env, readCookie(req.headers, sessionName(ctx, app, env)));
  if (user) {
    const role = roleOf(ctx, app, user);
    const headers: Record<string, string> = {
      'x-boxlite-user-id': user.id,
      'x-boxlite-user-provider': user.provider,
      'x-boxlite-user-role': role,
      'x-boxlite-identity': identityToken(ctx, user, app.name, env.name, role),
    };
    // Header values are bytes; names (and rarely emails) are not ASCII, so they travel URI-encoded.
    if (user.email) headers['x-boxlite-user-email'] = /^[\x20-\x7e]*$/.test(user.email) ? user.email : encodeURIComponent(user.email);
    if (user.name) headers['x-boxlite-user-name'] = encodeURIComponent(user.name);
    return { headers };
  }
  if (isProtected(auth.protect, path)) {
    if (!wantsHtml(req.method, req.headers)) return unauthenticated();
    return redirect(`/.boxlite/auth/login?next=${encodeURIComponent(path + req.url.search)}`);
  }
  return { headers: {} };
}

function authRoute(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow, route: string, providers: string[]): Response | Promise<Response> {
  const q = req.url.searchParams;
  const secure = appSecure(ctx, app, env);
  if (route === '/jwks.json') return jwksResponse(ctx);
  if (route === '/me') {
    const user = sessionUser(ctx, env, readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure)));
    if (!user) return unauthenticated();
    return Response.json({ id: user.id, email: user.email, name: user.name, provider: user.provider, role: roleOf(ctx, app, user), avatar_url: user.avatar_url }, { headers: { 'cache-control': 'no-store' } });
  }
  if (route === '/complete') return complete(ctx, req, app, env);
  const next = safeNext(q.get('next'));
  if (next === null) return htmlPage('Bad sign-in link', '<h1>This sign-in link is not valid</h1><p><code>next</code> must be a path inside the app.</p>', 400);
  if (route === '/logout') {
    const token = readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure));
    if (token) ctx.store.run('UPDATE app_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now(), sha256hex(token));
    return redirect(next, new Headers({ 'set-cookie': setCookieValue(secure, hostCookieName(SESSION_COOKIE_NAME, secure), '', '/', 0) }));
  }
  if (route !== '/login') return htmlPage('Not found', '<h1>Not found</h1>', 404);

  if (sessionUser(ctx, env, readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure)))) return redirect(next);
  const ready = providers.filter((p) => oauthClientFor(ctx, app, p));
  if (!ready.length) {
    return htmlPage('Sign-in unavailable', `<h1>Sign-in is not available yet</h1><p>None of this app's sign-in providers (${escapeHtml(providers.join(', '))}) is configured on this platform yet.</p>`, 503);
  }
  const asked = q.get('provider');
  if (asked !== null && !ready.includes(asked)) return htmlPage('Unknown provider', `<h1>${escapeHtml(asked)} sign-in is not available for ${escapeHtml(app.name)}</h1>`, 400);
  const provider = asked ?? (ready.length === 1 ? ready[0]! : null);
  if (!provider) {
    const buttons = ready
      .map((p) => `<a class="btn" href="${escapeHtml(`/.boxlite/auth/login?provider=${p}&next=${encodeURIComponent(next)}`)}">Continue with ${escapeHtml(OAUTH_PROVIDERS[p]!.label)}</a>`)
      .join('');
    return htmlPage(`Sign in to ${app.name}`, `<h1>Sign in to ${escapeHtml(app.name)}</h1>${buttons}`, 200);
  }
  // The provider's registered callback is on the API origin, so the PKCE verifier has to be set there.
  const nonce = randomBytes(24).toString('base64url');
  const start = new URLSearchParams({ app: app.name, env: env.name, provider, next, bh: sha256hex(nonce) });
  return redirect(`${ctx.config.publicUrl}${AUTH_PATH}start?${start}`, new Headers({ 'set-cookie': setCookieValue(secure, loginNonceName(secure), nonce, '/', STATE_TTL_S) }));
}

/** App origin: trades the one-time handoff code from the callback for a host-only session cookie. */
async function complete(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow): Promise<Response> {
  const code = req.url.searchParams.get('code') ?? '';
  const secure = appSecure(ctx, app, env);
  const nonce = readCookie(req.headers, loginNonceName(secure));
  const clear = new Headers({ 'set-cookie': setCookieValue(secure, loginNonceName(secure), '', '/', 0) });
  const ts = now();
  const row = code ? ctx.store.get<{ user_id: string; next: string; browser_hash: string }>('SELECT user_id, next, browser_hash FROM auth_handoffs WHERE hash = ? AND env_id = ? AND used_at IS NULL AND expires_at > ?', sha256hex(code), env.id, ts) : undefined;
  const sameBrowser = !!row && !!nonce && safeEqual(sha256hex(nonce), row.browser_hash);
  const used = row && sameBrowser ? Number(ctx.store.run('UPDATE auth_handoffs SET used_at = ? WHERE hash = ? AND used_at IS NULL', ts, sha256hex(code)).changes) : 0;
  if (!row || !sameBrowser || used !== 1) {
    if (row && !sameBrowser) authLog(ctx, env, 'warn', 'sign-in rejected: it was finished in a browser that did not start it');
    return htmlPage('Sign-in expired', `<h1>Start the sign-in again</h1><p>This sign-in link was already used, is older than a minute, or was opened in a different browser.</p><p><a href="/.boxlite/auth/login">Sign in</a></p>`, 400, clear);
  }
  const user = ctx.store.get<AppUser>('SELECT * FROM app_users WHERE id = ? AND env_id = ?', row.user_id, env.id);
  if (!user) return htmlPage('Sign-in failed', '<h1>Sign-in failed</h1><p>The account is gone. Sign in again.</p>', 400);
  if (user.blocked) return noAccessPage(app.name, clear);
  const { token } = createSession(ctx, user, 'oauth', SESSION_TTL_S);
  // Path=/: the cookie covers the whole origin (without a Path it would default to /.boxlite/auth).
  clear.append('set-cookie', setCookieValue(secure, hostCookieName(SESSION_COOKIE_NAME, secure), token, '/', SESSION_COOKIE_MAX_AGE_S));
  clear.set('referrer-policy', 'no-referrer');
  return redirect(safeNext(row.next) ?? '/', clear);
}
