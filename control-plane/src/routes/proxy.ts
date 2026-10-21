import { RETENTION_DAYS } from '../lifecycle.js';
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { appForKey, bearer, safeEqual, sha256hex, type Vars } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { identityFor, jwks, normalisePath, readCookie, safeNext, hostCookieName } from '../enduser-auth.js';
import { fail } from '../errors.js';
import { RESERVED_NAMES } from '../platform.js';
import { forwardHeaders } from '../supervisor.js';
import { body, envOf, escapeHtml } from './util.js';

/**
 * End-user traffic. Every app env has its own origin (origins.ts) and the app lives at its `/`:
 * no prefix, nothing rewritten except a Location that points at the Box tunnel. On an app origin the
 * CP itself answers only `/.boxlite/open` (one-time tickets) and `/.boxlite/auth/*`; every other
 * `/.boxlite/*` is a 404 and the rest is forwarded to the env's supervisor gateway.
 *
 * Access gate for private/org envs (security review F7, no App key in URLs):
 *   - cookie `bxl_access` (host-only), set by `/.boxlite/open?t=<ticket>`; tickets come from
 *     `POST /v1/apps/:app/envs/:env/open-ticket` (App key) or the console, live 60 s, single use;
 *   - `Authorization: Bearer bxl_app_…` of this app: passes, and the header is stripped. Another
 *     app's key → 401 without forwarding. Other Authorization headers belong to the app.
 */

export const ACCESS_COOKIE = 'bxl_access';
const accessName = (ctx: Ctx, app: AppRow, env: EnvRow) => hostCookieName(ACCESS_COOKIE, ctx.resources.appUrl(app.name, env.name).startsWith('https:'));
export const TICKET_TTL_S = 60;
const ACCESS_TTL_S = 7 * 24 * 3600;

// ---- access cookie and tickets --------------------------------------------------

const accessMac = (secret: string, envId: string, exp: number) => createHmac('sha256', secret).update(`app-access:${envId}.${exp}`).digest('base64url');

/** `<env id>.<expiry>.<hmac>`: bound to the env id, so a recycled port's old cookies open nothing. */
export function signAccess(secret: string, envId: string, ttlSeconds = ACCESS_TTL_S): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${envId}.${exp}.${accessMac(secret, envId, exp)}`;
}

export function verifyAccess(secret: string, value: string | undefined, envId: string): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [id, expText, mac] = parts as [string, string, string];
  const exp = Number(expText);
  if (id !== envId || !Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(mac, accessMac(secret, id, exp));
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

/** `/v1/apps/:app/envs/:env/open-ticket` (App key): what `boxlite-app app open` and agents use. */
export function openTicketRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  r.post('/envs/:env/open-ticket', async (c) => {
    const env = envOf(ctx, c);
    const b = c.req.header('content-type')?.includes('json') ? await body(c, z.object({ next: z.string().max(2000).optional() })) : {};
    return c.json(createOpenTicket(ctx, c.get('app'), env, b.next ?? c.req.query('next'), c.get('actor')), 201);
  });
  return r;
}

// ---- response rewriting ----------------------------------------------------------

/** A redirect from the app to its own Box tunnel URL is mapped to the env's public origin. */
export function rewriteLocation(loc: string, boxUrl: string, appUrl: string): string {
  const box = boxUrl.replace(/\/+$/, '');
  if (loc === box || loc.startsWith(box + '/') || loc.startsWith(box + '?')) {
    const rest = loc.slice(box.length);
    return appUrl + (rest.startsWith('/') ? rest : '/' + rest);
  }
  return loc;
}

/**
 * Security review F9: an app may not set a platform cookie (`bxl_*`, also behind `__Host-`/`__Secure-`)
 * nor a cookie with a `Domain` attribute, which would reach sibling origins. Returns null to drop it.
 */
export function filterSetCookie(cookie: string): string | null {
  const name = cookie.slice(0, Math.max(cookie.indexOf('='), 0)).trim().replace(/^__(host|secure)-/i, '');
  if (!name || /^bxl_/i.test(name)) return null;
  if (cookie.split(';').slice(1).some((attr) => /^\s*domain\s*(=|$)/i.test(attr))) return null;
  return cookie;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/**
 * Platform cookies on an app origin are all `bxl_*`, `__Host-bxl_*` on https (apps cannot set such
 * names); none reaches the app.
 */
function appCookies(header: string): string | null {
  const kept = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(__(host|secure)-)?bxl_/i.test(s));
  return kept.length ? kept.join('; ') : null;
}

function page(title: string, html: string, status: number, headers: Record<string, string> = {}): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headers['x-refresh'] ? `<meta http-equiv="refresh" content="${headers['x-refresh']}">` : ''}<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}code{background:#f3f3f3;padding:0 .25rem}.hint{color:#666;font-size:13px}</style></head><body>${html}</body></html>`;
  const h: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers };
  delete h['x-refresh'];
  return new Response(doc, { status, headers: h });
}

function startingPage(app: string): Response {
  return page(`Starting ${app}…`, `<h1>Starting ${escapeHtml(app)}…</h1><p>The app was asleep and is waking up. This page reloads by itself.</p>`, 503, {
    'retry-after': '3',
    'x-refresh': '3',
    'x-boxlite-starting': '1',
  });
}

const wantsHtml = (headers: Headers) => (headers.get('accept') ?? '').includes('text/html');

function jsonError(status: number, code: string, message: string, next: string): Response {
  return new Response(JSON.stringify({ error: { code, message, next } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** The 401 of the access gate: what happened and how to get in, for people and for agents. */
function gatePage(ctx: Ctx, app: AppRow, env: EnvRow, access: string, headers: Headers): Response {
  const label = env.name === 'main' ? app.name : `${app.name} (${env.name})`;
  if (!wantsHtml(headers)) {
    return jsonError(401, 'unauthenticated', `${label} is ${access}`, 'open it from the BoxLite console, or send Authorization: Bearer <App key>');
  }
  const consoleLink = `${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}`;
  return page(
    `${label} is ${access}`,
    `<h1>${escapeHtml(label)} is ${escapeHtml(access)}</h1>
<p>Only its owners can open this app, and this browser is not signed in to it yet.</p>
<p><a href="${escapeHtml(consoleLink)}">Open it from the BoxLite console</a> with <b>Open app</b>. That signs this browser in to the app for 7 days.</p>
<p class="hint">Coding agents: send the App key as <code>Authorization: Bearer $BOXLITE_API_KEY</code>.</p>`,
    401,
  );
}

// ---- forwarding ----------------------------------------------------------------------

export interface ForwardRequest {
  method: string;
  /** Request path with query string, always starting with `/`, exactly as the app sees it. */
  path: string;
  headers: Headers;
  body: ReadableStream | null;
  /** X-Forwarded-Host/Proto; default: the env's origin. */
  publicHost?: string;
  publicProto?: string;
  clientIp?: string;
  /** X-BoxLite-User-* / X-BoxLite-Identity for a signed-in end user (enduser-auth.ts). */
  identity?: Record<string, string>;
}

/**
 * Sends one request to the env's supervisor gateway through the Box tunnel. Also used by the
 * scheduler and the CLI probe, so they wake a sleeping Box the same way a visitor does.
 */
export async function forward(ctx: Ctx, app: AppRow, env: EnvRow, req: ForwardRequest): Promise<Response> {
  if (!env.box_id || !env.box_url || !env.live_deployment) {
    return page(`${app.name} is not deployed`, `<h1>${escapeHtml(app.name)} is not deployed yet</h1><p>Run <code>boxlite-app deploy</code>.</p>`, 503);
  }
  let status = 'unknown';
  try {
    status = await ctx.resources.boxStatus(env.box_id);
  } catch (err) {
    console.error(`[proxy] box status ${env.box_id}: ${(err as Error).message}`);
  }
  if (status === 'stopped') {
    void ctx.resources.wake(env.box_id);
    return startingPage(app.name);
  }

  const appUrl = ctx.resources.appUrl(app.name, env.name);
  const origin = new URL(appUrl);
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'x-boxlite-gateway' || key === 'x-boxlite-identity' || key.startsWith('x-boxlite-user-') || key.startsWith('x-forwarded-')) return;
    if (key === 'cookie') {
      const kept = appCookies(v);
      if (kept) headers.set('cookie', kept);
      return;
    }
    headers.set(k, v);
  });
  for (const [k, v] of Object.entries(forwardHeaders(env))) headers.set(k, v);
  for (const [k, v] of Object.entries(req.identity ?? {})) headers.set(k, v);
  headers.set('x-forwarded-host', req.publicHost ?? origin.host);
  headers.set('x-forwarded-proto', req.publicProto ?? origin.protocol.replace(':', ''));
  const xff = req.headers.get('x-forwarded-for');
  if (req.clientIp) headers.set('x-forwarded-for', xff ? `${xff}, ${req.clientIp}` : req.clientIp);
  else if (xff) headers.set('x-forwarded-for', xff);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;
  let res: Response;
  try {
    res = await fetch(env.box_url + req.path, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      // Node's fetch needs this to stream a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (err) {
    if (ctx.resources.recentlyWoken(env.box_id) || status !== 'running') return startingPage(app.name);
    return page('Bad gateway', `<h1>${escapeHtml(app.name)} is not answering</h1><p>${escapeHtml((err as Error).message)}</p>`, 502);
  }

  if (res.status === 502 || res.status === 503 || res.status === 504) {
    let text = '';
    if (res.status === 503) text = await res.text().catch(() => '');
    // BOX_STARTING/BOX_STOPPED come from the BoxLite proxy; service_unavailable from the supervisor
    // while the exposed service is (re)starting after a wake or restart.
    const starting = /BOX_STARTING|BOX_STOPPED|service_unavailable/.test(text) || ctx.resources.recentlyWoken(env.box_id) || status !== 'running';
    if (starting) {
      if (/BOX_STOPPED/.test(text)) void ctx.resources.wake(env.box_id);
      await res.body?.cancel().catch(() => undefined);
      return startingPage(app.name);
    }
    if (res.status === 503) return new Response(text, { status: 503, headers: responseHeaders(res, env.box_url, appUrl) });
  }

  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers: responseHeaders(res, env.box_url, appUrl) });
}

function responseHeaders(res: Response, boxUrl: string, appUrl: string): Headers {
  const out = new Headers();
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // fetch() already decoded the body, so the upstream encoding/length no longer apply.
    if (HOP_BY_HOP.has(key) || key === 'content-encoding' || key === 'set-cookie') return;
    if (key === 'location') out.set('location', rewriteLocation(v, boxUrl, appUrl));
    else out.set(k, v);
  });
  for (const cookie of res.headers.getSetCookie()) {
    const kept = filterSetCookie(cookie);
    if (kept) out.append('set-cookie', kept);
  }
  return out;
}

// ---- the app origin -------------------------------------------------------------------

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

/** Every request that arrives on an env's own port (server.ts dispatches by local port). */
export async function serveAppOrigin(ctx: Ctx, c: Context, env: EnvRow): Promise<Response> {
  const url = new URL(c.req.url);
  const app = ctx.store.appById(env.app_id);
  if (!app) return page('Not found', '<h1>No app here</h1>', 404);
  if (app.deleted_at) {
    return page('App deleted', `<h1>${escapeHtml(app.name)} has been deleted</h1><p>Its owner can restore it from the BoxLite console for ${RETENTION_DAYS} days.</p>`, 410);
  }
  const path = url.pathname;
  // Public: app servers fetch the key from their own (maybe private) origin.
  if (path === '/.boxlite/auth/jwks.json') return Response.json(jwks(ctx), { headers: { 'cache-control': 'public, max-age=300' } });
  if (path === '/.boxlite/open') return openWithTicket(ctx, app, env, url);

  const headers = new Headers(c.req.raw.headers);
  const key = keyGate(ctx, app, headers);
  if (key instanceof Response) return key;
  if (key === 'ok') headers.delete('authorization');
  const access = ctx.resources.effectiveAccess(env);
  if (access !== 'public' && key !== 'ok' && !verifyAccess(ctx.config.sessionSecret, readCookie(headers, accessName(ctx, app, env)), env.id)) return gatePage(ctx, app, env, access, headers);

  const identity = await identityFor(ctx, { method: c.req.method, url, headers }, app, env);
  if (identity instanceof Response) return identity;

  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return forward(ctx, app, env, {
    method: c.req.method,
    path: path + url.search,
    headers,
    body: c.req.raw.body,
    publicHost: c.req.header('x-forwarded-host') ?? c.req.header('host'),
    publicProto: c.req.header('x-forwarded-proto'),
    clientIp: incoming?.socket.remoteAddress,
    identity: identity.headers,
  });
}

function openWithTicket(ctx: Ctx, app: AppRow, env: EnvRow, url: URL): Response {
  const next = safeNext(url.searchParams.get('next')) ?? '/';
  const noRef = { 'referrer-policy': 'no-referrer' };
  if (!consumeTicket(ctx, env, url.searchParams.get('t') ?? '')) {
    return page(
      'Link expired',
      `<h1>This link has expired</h1><p>Links that open ${escapeHtml(app.name)} work once, within a minute. Open the app again from the <a href="${escapeHtml(`${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}`)}">BoxLite console</a>.</p>`,
      401,
      noRef,
    );
  }
  const cookie = [`${accessName(ctx, app, env)}=${signAccess(ctx.config.sessionSecret, env.id)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ACCESS_TTL_S}`];
  if (ctx.resources.appUrl(app.name, env.name).startsWith('https:')) cookie.push('Secure');
  return new Response(null, { status: 302, headers: { location: next, 'set-cookie': cookie.join('; '), 'cache-control': 'no-store', ...noRef } });
}

// ---- legacy path prefixes on the API origin (one release) -------------------------------

/** `/<app>/…` → main, `/<app>--<env>/…` → env: the pre-origins URL scheme. */
export function parsePrefix(pathname: string): { app: string; env: string; prefix: string; rest: string } | null {
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

// ---- WebSocket -------------------------------------------------------------------------

/**
 * WebSocket (and any other HTTP Upgrade) on an app origin: same gate and headers as `forward`,
 * then the two sockets are spliced together. Upgrades on the API or console origin are refused.
 */
export async function handleUpgrade(ctx: Ctx, req: IncomingMessage, socket: Duplex, head: Buffer, localPort: number): Promise<void> {
  const reject = (code: number, text: string) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const role = ctx.origins.roleOf(localPort);
  if (role.kind !== 'app') return reject(404, 'Not Found');
  const env = role.env;
  const app = ctx.store.appById(env.app_id);
  if (!app || app.deleted_at || !env.box_url) return reject(404, 'Not Found');
  const url = new URL(req.url ?? '/', 'http://app.local');
  const incoming = new Headers(Object.entries(req.headers).flatMap(([k, v]): [string, string][] => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]])));
  const key = keyGate(ctx, app, incoming);
  if (key instanceof Response) return reject(401, 'Unauthorized');
  if (ctx.resources.effectiveAccess(env) !== 'public' && key !== 'ok' && !verifyAccess(ctx.config.sessionSecret, readCookie(incoming, accessName(ctx, app, env)), env.id)) return reject(401, 'Unauthorized');
  if (normalisePath(url.pathname).toLowerCase().startsWith('/.boxlite')) return reject(404, 'Not Found');
  const identity = await identityFor(ctx, { method: req.method ?? 'GET', url, headers: incoming }, app, env);
  if (identity instanceof Response) return reject(identity.status, identity.status === 401 ? 'Unauthorized' : identity.status === 404 ? 'Not Found' : 'Forbidden');
  const target = new URL(env.box_url + url.pathname + url.search);
  const origin = new URL(ctx.resources.appUrl(app.name, env.name));
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || k === 'x-boxlite-gateway' || k === 'x-boxlite-identity' || k.startsWith('x-boxlite-user-') || k.startsWith('x-forwarded-')) continue;
    if (k === 'authorization' && key === 'ok') continue;
    if (k === 'cookie') {
      const kept = appCookies(Array.isArray(v) ? v.join('; ') : v);
      if (kept) headers.cookie = kept;
      continue;
    }
    headers[k] = v;
  }
  Object.assign(headers, forwardHeaders(env));
  headers['x-forwarded-host'] = req.headers.host ?? origin.host;
  headers['x-forwarded-proto'] = origin.protocol.replace(':', '');
  Object.assign(headers, identity.headers);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers });
  up.on('upgrade', (res, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    // Either side going away tears down the other, so no half-open tunnel lingers.
    for (const s of [upSocket, socket]) {
      s.on('error', close);
      s.on('close', close);
    }
  });
  up.on('response', (res) => {
    reject(res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway');
    res.resume();
  });
  up.on('error', () => reject(502, 'Bad Gateway'));
  up.end();
}
