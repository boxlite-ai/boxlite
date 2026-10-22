import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { safeEqual } from './auth.js';
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import { viewerOf, type Viewer } from './orgs.js';
import { fail } from './errors.js';
import { hostCookieName, isSecureUrl } from './http/cookies.js';
import { escapeHtml } from './http/html.js';
import { signExpiring, verifyExpiring } from './http/signed-token.js';

/**
 * Console sessions: an HMAC-signed, host-only cookie on the console's own origin (origins.ts),
 * `Path=/` (`__Host-bxl_console` on https, which requires that path), holding who is signed in:
 * a console user id (GitHub sign-in, console-signin.ts; their org from orgs.ts), or `admin` for the
 * platform operator who pastes the CP's ADMIN_TOKEN.
 */

export const CONSOLE_COOKIE = 'bxl_console';
export const CONSOLE_TTL_SECONDS = 7 * 24 * 3600;
const TTL_SECONDS = CONSOLE_TTL_SECONDS;
/** The session value of the platform operator (admin token). */
export const CONSOLE_USER = 'admin';

/** `<user>.<expiry>.<mac>`, the MAC over `<user>:<expiry>` (http/signed-token.ts). */
export function signConsoleSession(secret: string, user = CONSOLE_USER, ttlSeconds = TTL_SECONDS): string {
  return signExpiring(secret, 'console-session', user, ttlSeconds, ':');
}

/** The signed-in console user, or null. */
export function verifyConsoleSession(secret: string, value: string | undefined): string | null {
  return verifyExpiring(secret, 'console-session', value, ':');
}

/**
 * `__Host-bxl_console` on https: every origin shares the parent domain, so an app could plant a
 * `Domain=` cookie of the plain name ("cookie tossing"); `__Host-` cookies cannot be set that way.
 */
export const consoleCookieName = (config: Pick<Config, 'publicUrl'>) => hostCookieName(CONSOLE_COOKIE, isSecureUrl(config.publicUrl));

export function consoleUser(config: Config, c: Context): string | null {
  return verifyConsoleSession(config.sessionSecret, getCookie(c, consoleCookieName(config)));
}

/** Who is using the console, or null (no session, or a user who no longer exists). */
export function consoleViewer(ctx: Pick<Ctx, 'store' | 'config'>, c: Context): Viewer | null {
  return viewerOf(ctx, consoleUser(ctx.config, c));
}

/** Console API writes must send this header (value `1`). */
export const CONSOLE_CSRF_HEADER = 'x-boxlite-console';

/**
 * CSRF for console API writes. App origins are same-site with the console (all are
 * `*.proxy.dev.boxlite.ai`), so SameSite=Lax does not stop them. A custom header forces a CORS
 * preflight, which the console never answers, so no other origin can send it; the Origin check
 * stays as a second line.
 */
function csrfProblem(c: Context): string | null {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return null;
  if (c.req.header(CONSOLE_CSRF_HEADER) !== '1') return `console API writes must send ${CONSOLE_CSRF_HEADER}: 1`;
  const origin = c.req.header('origin');
  if (!origin) return null;
  try {
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
    return new URL(origin).host === host ? null : 'cross-site request refused';
  } catch {
    return 'cross-site request refused';
  }
}

/** /console/api/*: JSON 401 without a session. */
export function requireConsoleApi(ctx: Pick<Ctx, 'store' | 'config'>): MiddlewareHandler {
  return async (c, next) => {
    if (!consoleViewer(ctx, c)) throw fail('unauthenticated', 'sign in to the console first', 'open /console/login');
    const problem = csrfProblem(c);
    if (problem) throw fail('forbidden', problem);
    await next();
  };
}

/** /console/* pages: redirect to the login page without a session. */
export function requireConsolePage(ctx: Pick<Ctx, 'store' | 'config'>): MiddlewareHandler {
  return async (c, next) => {
    if (!consoleViewer(ctx, c)) {
      const url = new URL(c.req.url);
      const back = url.pathname + url.search;
      return c.redirect(`/console/login${back && back !== '/console/' ? `?next=${encodeURIComponent(back)}` : ''}`, 302);
    }
    await next();
  };
}

export function consoleNext(v: string | undefined): string {
  // Only paths inside the console; never an absolute or protocol-relative URL.
  return v && v.startsWith('/console/') && !v.startsWith('//') ? v : '/console/';
}

function loginPage(error: string | null, next: string, github: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · BoxLite console</title>
<style>body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:30rem;margin:18vh auto;padding:0 1rem;color:#222}h1{font-size:1.2rem}
input{width:100%;box-sizing:border-box;font:inherit;padding:.55rem .7rem;border:1px solid #bbb;margin:.4rem 0 .8rem}button{font:inherit;font-weight:600;padding:.5rem 1rem;border:0;background:#111;color:#fff;cursor:pointer}
.err{color:#b00020}.hint{color:#666;font-size:12px}
a.gh{display:inline-block;font-weight:600;padding:.6rem 1.1rem;background:#111;color:#fff;text-decoration:none}details{margin-top:2rem}summary{cursor:pointer}</style></head><body>
<h1>BoxLite console</h1>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
${github ? `<p><a class="gh" href="/console/login/github?next=${encodeURIComponent(next)}">Continue with GitHub</a></p><p class="hint">Your first sign-in creates your organization. You stay signed in for 7 days on this browser.</p>` : ''}
<details${github ? '' : ' open'}><summary class="hint">Platform operator: sign in with the admin token</summary>
<form method="post" action="/console/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Admin token<input name="token" type="password" autocomplete="current-password"${github ? '' : ' autofocus'} required></label><button type="submit">Sign in</button></form>
</details>
</body></html>`;
}

export function loginRoutes(ctx: Pick<Ctx, 'store' | 'config'>, github: boolean) {
  const { config } = ctx;
  const secure = isSecureUrl(config.publicUrl);
  return {
    page: (c: Context) => {
      if (consoleViewer(ctx, c)) return c.redirect(consoleNext(c.req.query('next')), 302);
      return c.html(loginPage(null, consoleNext(c.req.query('next')), github), 200, { 'cache-control': 'no-store' });
    },
    submit: async (c: Context) => {
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const token = typeof form.token === 'string' ? form.token.trim() : '';
      const next = consoleNext(typeof form.next === 'string' ? form.next : undefined);
      if (!token || !safeEqual(token, config.adminToken)) return c.html(loginPage('That token does not match this control plane.', next, github), 401, { 'cache-control': 'no-store' });
      // Path=/ (required by __Host-): the console has its own origin, so nothing else shares the path.
      setCookie(c, consoleCookieName(config), signConsoleSession(config.sessionSecret), { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: TTL_SECONDS });
      return c.redirect(next, 302);
    },
    logout: (c: Context) => {
      deleteCookie(c, consoleCookieName(config), { path: '/', secure });
      return c.redirect('/console/login', 302);
    },
  };
}
