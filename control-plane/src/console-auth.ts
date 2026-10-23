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

// The console's door, as the mock was approved: the Box, drawn by the ascii-magic library's
// rotating cube (vendor/ascii-magic-art, served from this origin), beside one heading and one
// button, dark like the console it opens. The operator's token form sits behind a disclosure
// at the foot. ART_PIECE/ART_LOOK pick the piece and its character look.
const ART_PIECE = 'rotating-cube';
const ART_LOOK = 'dots';
const GITHUB_MARK = 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';
const BOXLITE_MARK = '<svg viewBox="-11 -7 22 24" aria-hidden="true"><path d="M0,-6 L10,0 L0,6 L-10,0 Z" fill="rgba(0,176,240,.25)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/><path d="M10,0 L10,10 L0,16 L0,6 Z" fill="rgba(0,176,240,.12)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/><path d="M-10,0 L-10,10 L0,16 L0,6 Z" fill="rgba(0,176,240,.05)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/></svg>';

function loginPage(error: string | null, next: string, github: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · BoxLite</title>
<style>
:root{color-scheme:dark;--bg:hsl(218 17% 7%);--mute:hsl(221 7% 58%);--line:hsl(221 16% 16%)}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:#fff;font:13px/1.6 'IBM Plex Mono',ui-monospace,'SFMono-Regular','SF Mono',Menlo,monospace;display:grid;grid-template-columns:minmax(0,1fr) 440px}
.stage{position:relative;border-right:1px solid var(--line);display:flex;align-items:center;justify-content:center;overflow:hidden}
@media (max-width:900px){body{grid-template-columns:1fr;grid-template-rows:260px minmax(0,1fr)}.stage{border-right:0;border-bottom:1px solid var(--line)}.door{padding:24px 28px}}
ascii-art{display:block}
.door{display:flex;flex-direction:column;padding:32px 48px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.2px}.brand svg{width:18px;height:20px}
main{margin:auto 0}
.eyebrow{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--mute)}.eyebrow::before{content:'▸ ';color:hsl(196 100% 47%)}
h1{font-family:Inter,system-ui,sans-serif;font-size:28px;font-weight:600;letter-spacing:-.5px;margin:10px 0 6px}
.lede{color:var(--mute);margin:0 0 28px;max-width:34ch}
.err{color:hsl(5 71% 62%);margin:0 0 16px}
.gh{display:flex;align-items:center;justify-content:center;gap:10px;height:44px;background:#fff;color:var(--bg);font-weight:600;text-decoration:none}
.gh:hover{opacity:.88}.gh svg{width:16px;height:16px}
.note{font-size:12px;color:var(--mute);margin-top:14px}
footer{font-size:12px;color:var(--mute);display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
details{max-width:300px}summary{cursor:pointer;color:var(--mute);list-style:none;border-bottom:1px solid var(--line);display:inline}summary::-webkit-details-marker{display:none}summary:hover{color:#fff}
form{margin-top:12px;text-align:left}label{display:block;font-size:12px;color:var(--mute)}
input{width:100%;font:inherit;padding:.5rem .7rem;margin:.3rem 0 .6rem;background:hsl(222 16% 10%);border:1px solid hsl(221 16% 20%);color:#fff}
input:focus{outline:none;border-color:hsl(196 100% 47%)}
button{font:inherit;font-weight:600;padding:.45rem 1rem;border:0;background:#fff;color:var(--bg);cursor:pointer}
</style></head><body>
<div class="stage"><ascii-art piece="${ART_PIECE}" look="${ART_LOOK}" size="14" speed="0.5"></ascii-art></div>
<div class="door">
<div class="brand">${BOXLITE_MARK}BoxLite</div>
<main>
<div class="eyebrow">Apps</div>
<h1>Sign in</h1>
<p class="lede">Your apps, built by your coding agent, each running in its own Box.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
${github ? `<a class="gh" href="/console/login/github?next=${encodeURIComponent(next)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg>Continue with GitHub</a><p class="note">First sign-in creates your organization. Stays signed in for 7 days on this browser.</p>` : ''}
</main>
<footer><span style="white-space:nowrap">© BoxLite</span>
<details${github ? '' : ' open'}><summary>Platform operator: sign in with the admin token</summary>
<form method="post" action="/console/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Admin token<input name="token" type="password" autocomplete="current-password"${github ? '' : ' autofocus'} required></label><button type="submit">Sign in</button></form>
</details></footer>
</div>
<script type="module" src="/console/vendor/ascii-magic-art/runtime/ascii.js"></script>
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
