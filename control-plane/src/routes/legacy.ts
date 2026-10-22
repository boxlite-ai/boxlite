/** 301s from the old `<cp>/<app>/` path-prefix URLs to each env's own origin; delete with M4. */
import type { Context } from 'hono';
import type { Ctx } from '../ctx.js';
import { RESERVED_NAMES } from '../platform.js';

/**
 * Legacy path prefixes on the API origin (code health M4).
 * Kept on purpose: the live CP still serves apps created before per-env origins (2026-10-21,
 * `hello` and `ledger`), whose old `<cp>/<app>/` links may be shared. Remove this section (and its
 * mount, last in server.ts, which then needs a JSON not-found) once those apps are gone.
 */

/** `/<app>/…` → main, `/<app>--<env>/…` → env: the pre-origins URL scheme. */
function parsePrefix(pathname: string): { app: string; env: string; prefix: string; rest: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const seg = m[1]!;
  const rest = m[2] ?? '';
  const sep = seg.indexOf('--');
  const app = sep === -1 ? seg : seg.slice(0, sep);
  const env = sep === -1 ? 'main' : seg.slice(sep + 2);
  if (!app || !env || RESERVED_NAMES.has(app)) return null;
  return { app, env, prefix: `/${seg}`, rest };
}

/** Old `https://<cp>/<app>/x` links answer 301 to the env's own origin, `/x`; `?__key=` is dropped. */
export function legacyRedirect(ctx: Ctx) {
  return (c: Context): Response => {
    const url = new URL(c.req.url);
    const p = parsePrefix(url.pathname);
    const app = p ? ctx.store.appByNameAnyState(p.app) : undefined;
    const env = p && app ? ctx.store.envByName(app.id, p.env) : undefined;
    if (!p || !env) return c.json({ error: { code: 'not_found', message: `nothing at ${url.pathname} on the API origin`, next: 'apps live at their own URL; `boxlite-app app status` shows it' } }, 404);
    url.searchParams.delete('__key');
    const search = url.searchParams.toString();
    return new Response(null, { status: 301, headers: { location: `${ctx.resources.appUrl(p.app, p.env)}${p.rest || '/'}${search ? `?${search}` : ''}`, 'cache-control': 'no-store' } });
  };
}
