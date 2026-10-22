/**
 * Console sign-in with GitHub. The OAuth app's one registered callback is on the API origin
 * (enduser/config.ts), so a sign-in crosses origins like an app's end-user sign-in does:
 *
 *   console  /console/login/github?next=   → login nonce cookie, 302 API /auth/console/start
 *   API      /auth/console/start           → PKCE verifier cookie (Path=/auth/), 302 GitHub
 *   API      /auth/callback/github         → state + PKCE checked, user and their org recorded (orgs.ts),
 *                                            one-time handoff code (60 s, hashed), 302 console
 *   console  /console/login/complete?code= → code + nonce checked, console session cookie, 302 next
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { safeEqual, sha256hex } from './auth.js';
import { consoleCookieName, consoleNext, CONSOLE_TTL_SECONDS, signConsoleSession } from './console-auth.js';
import type { Ctx } from './ctx.js';
import { now } from './db.js';
import { AUTH_PATH, HANDOFF_TTL_S, OAUTH_TIMEOUT_MS, STATE_TTL_S, apiSecure, redirectUri, withTimeout } from './enduser/config.js';
import { htmlPage, redirect } from './enduser/pages.js';
import { signState, type OAuthState } from './enduser/state.js';
import { hostCookieName, isSecureUrl, readCookie, setCookieValue } from './http/cookies.js';
import { escapeHtml } from './http/html.js';
import { OAUTH_PROVIDERS } from './oauth-providers.js';
import { signInConsoleUser } from './orgs.js';

const PROVIDER = 'github';
const VERIFIER_COOKIE = 'bxl_pkce_console';
const NONCE_COOKIE = 'bxl_console_login';

const consoleSecure = (ctx: Ctx) => isSecureUrl(ctx.origins.consoleUrl());
const nonceCookie = (ctx: Ctx) => hostCookieName(NONCE_COOKIE, consoleSecure(ctx));

/** Whether "Continue with GitHub" can work here: the GitHub OAuth app is configured. */
export const githubSignInAvailable = (ctx: Pick<Ctx, 'config'>) => !!ctx.config.oauth?.[PROVIDER];

/** Registers both halves: /console/login/* on the console origin, /auth/console/start on the API origin. */
export function mountConsoleSignIn(root: Hono, ctx: Ctx): void {
  root.get('/console/login/github', (c) => begin(ctx, c));
  root.get('/console/login/complete', (c) => complete(ctx, c));
  root.get('/auth/console/start', (c) => start(ctx, c.req.raw));
}

/** Console origin: a nonce for this browser, then off to the API origin. */
function begin(ctx: Ctx, c: Context): Response {
  if (!githubSignInAvailable(ctx)) return htmlPage('Sign-in unavailable', '<h1>GitHub sign-in is not set up on this control plane</h1>', 503);
  const nonce = randomBytes(32).toString('base64url');
  const next = consoleNext(c.req.query('next'));
  const q = new URLSearchParams({ bh: sha256hex(nonce), next });
  return redirect(`${ctx.config.publicUrl}/auth/console/start?${q}`, new Headers({ 'set-cookie': setCookieValue(consoleSecure(ctx), nonceCookie(ctx), nonce, '/', STATE_TTL_S) }));
}

/** API origin: PKCE verifier next to the callback, then GitHub. */
function start(ctx: Ctx, req: Request): Response {
  const q = new URL(req.url).searchParams;
  const creds = ctx.config.oauth?.[PROVIDER];
  const bh = q.get('bh') ?? '';
  if (!creds) return htmlPage('Sign-in unavailable', '<h1>GitHub sign-in is not set up on this control plane</h1>', 503);
  if (!/^[0-9a-f]{64}$/.test(bh)) return htmlPage('Bad sign-in link', '<h1>Start the sign-in from the console</h1>', 400);
  const verifier = randomBytes(32).toString('base64url');
  const state = signState(ctx.config.sessionSecret, { app: '', env: '', purpose: 'console', next: consoleNext(q.get('next') ?? undefined), provider: PROVIDER, vh: sha256hex(verifier), bh });
  const location = OAUTH_PROVIDERS[PROVIDER]!.authorizeUrl({ creds, redirectUri: redirectUri(ctx, PROVIDER), state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
  return redirect(location, new Headers({ 'set-cookie': setCookieValue(apiSecure(ctx), VERIFIER_COOKIE, verifier, AUTH_PATH, STATE_TTL_S) }));
}

/** API origin, from the shared callback: the user and their org, then a one-time code for the console. */
export async function consoleCallback(ctx: Ctx, st: OAuthState, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const retry = `<p><a href="${escapeHtml(`${ctx.origins.consoleUrl()}/console/login`)}">Try again</a></p>`;
  const headers = new Headers({ 'cache-control': 'no-store' });
  const verifier = readCookie(req.headers, VERIFIER_COOKIE);
  headers.append('set-cookie', setCookieValue(apiSecure(ctx), VERIFIER_COOKIE, '', AUTH_PATH, 0));
  if (url.searchParams.get('error')) return htmlPage('Sign-in cancelled', `<h1>Sign-in was cancelled</h1>${retry}`, 400, headers);
  if (!verifier || !safeEqual(sha256hex(verifier), st.vh)) {
    return htmlPage('Sign-in expired', `<h1>Start the sign-in again</h1><p>This browser did not start this sign-in, or it took longer than 10 minutes.</p>${retry}`, 400, headers);
  }
  const creds = ctx.config.oauth?.[PROVIDER];
  const code = url.searchParams.get('code');
  if (!creds || !code) return htmlPage('Sign-in failed', `<h1>Sign-in failed</h1>${retry}`, 400, headers);
  let user;
  try {
    const profile = await OAUTH_PROVIDERS[PROVIDER]!.signIn({ creds, redirectUri: redirectUri(ctx, PROVIDER), code, codeVerifier: verifier, fetch: withTimeout(ctx.oauthFetch ?? fetch, OAUTH_TIMEOUT_MS) });
    user = signInConsoleUser(ctx, PROVIDER, profile);
  } catch (err) {
    console.error(`[console] GitHub sign-in: ${(err as Error).message}`);
    return htmlPage('Sign-in failed', `<h1>GitHub sign-in failed</h1><p>${escapeHtml((err as Error).message)}</p>${retry}`, 502, headers);
  }
  const handoff = randomBytes(32).toString('base64url');
  ctx.store.run('DELETE FROM console_handoffs WHERE expires_at < ?', now());
  ctx.store.run(
    'INSERT INTO console_handoffs (hash, user_id, next, browser_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256hex(handoff),
    user.id,
    st.next,
    st.bh ?? '',
    new Date(Date.now() + HANDOFF_TTL_S * 1000).toISOString(),
  );
  headers.set('referrer-policy', 'no-referrer');
  return redirect(`${ctx.origins.consoleUrl()}/console/login/complete?code=${handoff}`, headers);
}

/** Console origin: the code must be fresh and come back to the browser that began the sign-in. */
function complete(ctx: Ctx, c: Context): Response {
  const code = c.req.query('code') ?? '';
  const nonce = readCookie(c.req.raw.headers, nonceCookie(ctx));
  const row = ctx.store.get<{ user_id: string; next: string; browser_hash: string; expires_at: string }>('SELECT user_id, next, browser_hash, expires_at FROM console_handoffs WHERE hash = ?', sha256hex(code));
  if (row) ctx.store.run('DELETE FROM console_handoffs WHERE hash = ?', sha256hex(code));
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  headers.append('set-cookie', setCookieValue(consoleSecure(ctx), nonceCookie(ctx), '', '/', 0));
  if (!row || row.expires_at < now() || !nonce || !safeEqual(sha256hex(nonce), row.browser_hash)) {
    return htmlPage('Sign-in expired', '<h1>Start the sign-in again</h1><p><a href="/console/login">Sign in</a></p>', 400, headers);
  }
  headers.append('set-cookie', setCookieValue(consoleSecure(ctx), consoleCookieName(ctx.config), signConsoleSession(ctx.config.sessionSecret, row.user_id), '/', CONSOLE_TTL_SECONDS));
  return redirect(consoleNext(row.next), headers);
}
