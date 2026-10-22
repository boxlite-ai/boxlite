/** The API-origin half of sign-in: `/auth/start`, `/auth/callback/<provider>`, `/auth/jwks.json`, and the handoff to the app origin. */
import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { safeEqual, sha256hex } from '../auth.js';
import type { EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { readCookie, setCookieValue } from '../http/cookies.js';
import { escapeHtml } from '../http/html.js';
import { recordLogs } from '../logsink.js';
import { OAUTH_PROVIDERS, type OAuthProfile } from '../oauth-providers.js';
import { AUTH_PATH, HANDOFF_TTL_S, OAUTH_TIMEOUT_MS, STATE_TTL_S, apiSecure, redirectUri, verifierCookieName, withTimeout } from './config.js';
import { jwksResponse } from './identity.js';
import { mirrorUser } from './mirror.js';
import { htmlPage, noAccessPage, redirect } from './pages.js';
import { safeNext } from './paths.js';
import { revokeSessions, upsertUser } from './sessions.js';
import { signState, verifyState } from './state.js';
import { consoleCallback } from '../console-signin.js';

/**
 * End-user sign-in for apps that declare `[auth]` (PRD 3.8, case 1): platform-hosted OAuth, a user
 * pool per app env, server-side sessions, and identity headers the app proxy injects.
 *
 * Every app env has its own origin (origins.ts); the OAuth app's one registered callback lives on
 * the API origin. A sign-in therefore crosses origins:
 *
 *   app origin  /.boxlite/auth/login?next=     → login nonce cookie `bxl_login`, 302 API /auth/start
 *                                                 (provider picked first if several)
 *   API origin  /auth/start                     → PKCE verifier cookie (Path=/auth/), 302 to the provider
 *   API origin  /auth/callback/<provider>       → state + PKCE checked, user upserted and mirrored,
 *                                                 one-time handoff code (60 s, hashed), 302 to the app origin
 *   app origin  /.boxlite/auth/complete?code=   → code + login nonce checked server-side, host-only
 *                                                 `bxl_session`, 302 next
 *   app origin  /.boxlite/auth/logout|me        → as before
 *   both        /auth/jwks.json, /.boxlite/auth/jwks.json
 */

/** Mounted on the API origin (server.ts keeps them off app and console origins). */
export function mountEndUserAuth(root: Hono, ctx: Ctx): void {
  root.get('/auth/jwks.json', () => jwksResponse(ctx));
  root.get('/auth/start', (c) => start(ctx, c.req.raw));
  root.get('/auth/callback/:provider', (c) => callback(ctx, c.req.param('provider'), c.req.raw));
}

/** Every sign-in outcome lands in the env's `auth` log so `app logs --source auth` explains what users saw. */
export function authLog(ctx: Ctx, env: EnvRow, level: 'info' | 'warn' | 'error', line: string): void {
  recordLogs(ctx, env.id, [{ ts: new Date().toISOString(), source: 'auth', level, line }]);
}

/** API origin: sets the PKCE verifier next to the callback and sends the browser to the provider. */
function start(ctx: Ctx, req: Request): Response {
  const q = new URL(req.url).searchParams;
  const app = ctx.store.appByName(q.get('app') ?? '');
  const env = app ? ctx.store.envByName(app.id, q.get('env') || 'main') : undefined;
  if (!app || !env) return htmlPage('Not found', '<h1>This app does not exist</h1>', 404);
  const auth = ctx.resources.currentSpec(env)?.auth;
  const providerName = q.get('provider') ?? '';
  const provider = OAUTH_PROVIDERS[providerName];
  const creds = ctx.config.oauth?.[providerName];
  if (!auth || !provider || !creds || !(auth.providers as string[]).includes(providerName)) {
    return htmlPage('Sign-in unavailable', `<h1>That sign-in method is not available for ${escapeHtml(app.name)}</h1>`, 400);
  }
  const next = safeNext(q.get('next'));
  if (next === null) return htmlPage('Bad sign-in link', '<h1>This sign-in link is not valid</h1><p><code>next</code> must be a path inside the app.</p>', 400);
  const bh = q.get('bh') ?? '';
  if (!/^[0-9a-f]{64}$/.test(bh)) return htmlPage('Bad sign-in link', `<h1>Start the sign-in from ${escapeHtml(app.name)}</h1>`, 400);
  const verifier = randomBytes(32).toString('base64url');
  const state = signState(ctx.config.sessionSecret, { app: app.name, env: env.name, next, provider: providerName, vh: sha256hex(verifier), bh });
  const location = provider.authorizeUrl({ creds, redirectUri: redirectUri(ctx, providerName), state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
  return redirect(location, new Headers({ 'set-cookie': setCookieValue(apiSecure(ctx), verifierCookieName(env.id), verifier, AUTH_PATH, STATE_TTL_S) }));
}

async function callback(ctx: Ctx, providerName: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provider = OAUTH_PROVIDERS[providerName];
  const st = verifyState(ctx.config.sessionSecret, url.searchParams.get('state'));
  if (!provider || !st || st.provider !== providerName) {
    return htmlPage('Sign-in expired', '<h1>This sign-in link has expired</h1><p>Go back to the app and sign in again.</p>', 400);
  }
  // The console's own sign-in shares the one registered callback.
  if (st.purpose === 'console') return consoleCallback(ctx, st, req);
  const app = ctx.store.appByName(st.app);
  const env = app ? ctx.store.envByName(app.id, st.env) : undefined;
  if (!app || !env) return htmlPage('Not found', '<h1>This app no longer exists</h1>', 404);
  const appUrl = ctx.resources.appUrl(app.name, env.name);
  const retry = `<p><a href="${escapeHtml(`${appUrl}/.boxlite/auth/login?next=${encodeURIComponent(st.next)}`)}">Try again</a></p>`;
  const headers = new Headers({ 'cache-control': 'no-store' });
  const verifierName = verifierCookieName(env.id);
  const verifier = readCookie(req.headers, verifierName);
  headers.append('set-cookie', setCookieValue(apiSecure(ctx), verifierName, '', AUTH_PATH, 0));

  if (url.searchParams.get('error')) authLog(ctx, env, 'warn', `${providerName} sign-in cancelled by the user (${url.searchParams.get('error')})`);
  if (url.searchParams.get('error')) return htmlPage('Sign-in cancelled', `<h1>Sign-in was cancelled</h1>${retry}`, 400, headers);
  // The verifier cookie binds the callback to the browser that started the sign-in.
  if (!verifier || !safeEqual(sha256hex(verifier), st.vh)) authLog(ctx, env, 'warn', `${providerName} sign-in rejected: callback came from a browser that did not start it, or after 10 minutes`);
  if (!verifier || !safeEqual(sha256hex(verifier), st.vh)) return htmlPage('Sign-in expired', `<h1>Start the sign-in again</h1><p>This browser did not start this sign-in, or it took longer than 10 minutes.</p>${retry}`, 400, headers);
  const creds = ctx.config.oauth?.[providerName];
  const auth = ctx.resources.currentSpec(env)?.auth;
  if (!creds || !(auth?.providers as string[] | undefined)?.includes(providerName)) return htmlPage('Sign-in unavailable', `<h1>${escapeHtml(provider.label)} sign-in is not enabled for ${escapeHtml(app.name)}</h1>`, 400, headers);
  const code = url.searchParams.get('code');
  if (!code) return htmlPage('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(provider.label)} sent no code.</p>${retry}`, 400, headers);

  let profile: OAuthProfile;
  try {
    profile = await provider.signIn({ creds, redirectUri: redirectUri(ctx, providerName), code, codeVerifier: verifier, fetch: withTimeout(ctx.oauthFetch ?? fetch, OAUTH_TIMEOUT_MS) });
  } catch (err) {
    console.error(`[auth] ${providerName} sign-in for ${app.name}/${env.name}: ${(err as Error).message}`);
    authLog(ctx, env, 'error', `${providerName} sign-in failed: ${(err as Error).message}`);
    return htmlPage('Sign-in failed', `<h1>${escapeHtml(provider.label)} sign-in failed</h1><p>${escapeHtml((err as Error).message)}</p>${retry}`, 502, headers);
  }
  const user = upsertUser(ctx, app, env, providerName, profile);
  if (user.blocked) {
    authLog(ctx, env, 'warn', `blocked user ${user.email} tried to sign in with ${providerName}`);
    revokeSessions(ctx, user.id);
    return noAccessPage(app.name, headers);
  }
  await mirrorUser(ctx, env.id, user);
  authLog(ctx, env, 'info', `${user.email} signed in with ${providerName} → ${st.next}`);
  // The session cookie must be set by the app origin itself (host-only), so hand over a one-time code.
  const handoff = randomBytes(32).toString('base64url');
  ctx.store.run('DELETE FROM auth_handoffs WHERE expires_at < ?', now());
  ctx.store.run(
    'INSERT INTO auth_handoffs (hash, env_id, user_id, next, browser_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256hex(handoff),
    env.id,
    user.id,
    st.next,
    st.bh ?? '',
    now(),
    new Date(Date.now() + HANDOFF_TTL_S * 1000).toISOString(),
  );
  headers.set('referrer-policy', 'no-referrer');
  return redirect(`${appUrl}/.boxlite/auth/complete?code=${handoff}`, headers);
}
