/** Forwarding to the env's supervisor gateway: waking a stopped Box, header and cookie filtering both ways, Location rewriting. */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { forwardHeaders } from '../supervisor.js';
import { badGatewayPage, notDeployedPage, notRunningPage, startingPage, timeoutPage } from './pages.js';

/**
 * Forwarding one request to the env's supervisor gateway through the Box tunnel, waking a stopped
 * Box first, and the header rules both ways: platform headers and cookies never reach the app, an
 * app may not set platform cookies, and a Location pointing at the Box tunnel is mapped back.
 */

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

export const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/**
 * Incoming headers that only the CP may set towards the gateway: the two gateway secrets, the
 * signed-in user's identity, and X-Forwarded-*. Dropped from every request (HTTP and WebSocket)
 * before the CP adds its own.
 */
export function isPlatformHeader(key: string): boolean {
  return key === 'x-boxlite-gateway' || key === 'x-boxlite-control' || key === 'x-boxlite-identity' || key.startsWith('x-boxlite-user-') || key.startsWith('x-forwarded-');
}

/**
 * Platform cookies on an app origin are all `bxl_*`, `__Host-bxl_*` on https (apps cannot set such
 * names); none reaches the app.
 */
export function appCookies(header: string): string | null {
  const kept = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(__(host|secure)-)?bxl_/i.test(s));
  return kept.length ? kept.join('; ') : null;
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
  /** X-BoxLite-User-* / X-BoxLite-Identity for a signed-in end user (enduser/app-origin.ts). */
  identity?: Record<string, string>;
  /** How long the app may take to start answering (response headers); default RESPONSE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * The app must start its response within this; the body may then stream for as long as it likes
 * (downloads, SSE). Without it a hung app held the request for undici's 300 s.
 */
const RESPONSE_TIMEOUT_MS = 100_000;

/**
 * Sends one request to the env's supervisor gateway through the Box tunnel. Also used by the
 * scheduler and the CLI probe, so they wake a sleeping Box the same way a visitor does.
 */
export async function forward(ctx: Ctx, app: AppRow, env: EnvRow, req: ForwardRequest): Promise<Response> {
  if (!env.box_id || !env.box_url || !env.live_deployment) {
    return notDeployedPage(ctx, app, env, req.headers);
  }
  let status = 'unknown';
  try {
    status = await ctx.resources.boxStatus(env.box_id);
  } catch (err) {
    console.error(`[proxy] box status ${env.box_id}: ${(err as Error).message}`);
  }
  // Neither waits for anything: say so, instead of a "Starting…" page that never ends.
  if (status === 'missing') return notRunningPage(ctx, app, env, 'box_missing', req.headers);
  if (status === 'stopped') {
    if (ctx.resources.wakeFailure(env.box_id)) return notRunningPage(ctx, app, env, 'wake_failed', req.headers);
    void ctx.resources.wake(env.box_id);
    return startingPage(app, env, req.headers);
  }

  const appUrl = ctx.resources.appUrl(app.name, env.name);
  const origin = new URL(appUrl);
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || isPlatformHeader(key)) return;
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
  const deadline = new AbortController();
  const timeoutMs = req.timeoutMs ?? RESPONSE_TIMEOUT_MS;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    res = await fetch(env.box_url + req.path, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      signal: deadline.signal,
      // Node's fetch needs this to stream a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (err) {
    if (deadline.signal.aborted) {
      return timeoutPage(ctx, app, env, Math.round(timeoutMs / 1000), req.headers);
    }
    if (ctx.resources.recentlyWoken(env.box_id) || status !== 'running') return startingPage(app, env, req.headers);
    return badGatewayPage(ctx, app, env, (err as Error).message, req.headers);
  } finally {
    clearTimeout(timer);
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
      return startingPage(app, env, req.headers);
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
