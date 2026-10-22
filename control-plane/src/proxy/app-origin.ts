/** The entry point for every request on an app env's own origin: deleted app, tickets, access gate, sign-in, then forward. */
import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import { identityFor } from '../enduser/app-origin.js';
import type { EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { jwks } from '../enduser/identity.js';
import { escapeHtml } from '../http/html.js';
import { isResponse } from '../http/response.js';
import { RETENTION_DAYS } from '../lifecycle.js';
import { forward } from './forward.js';
import { accessGate, openWithTicket } from './gate.js';
import { gatePage, page } from './pages.js';

/**
 * End-user traffic. Every app env has its own origin (origins.ts) and the app lives at its `/`:
 * no prefix, nothing rewritten except a Location that points at the Box tunnel. On an app origin the
 * CP itself answers only `/.boxlite/open` (one-time tickets) and `/.boxlite/auth/*`; every other
 * `/.boxlite/*` is a 404 and the rest is forwarded to the env's supervisor gateway.
 *
 * Order per request: deleted app → JWKS and tickets (public) → access gate (gate.ts) → end-user
 * sign-in (enduser/app-origin.ts) → forward (forward.ts). WebSocket upgrades: upgrade.ts.
 */

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
  const gate = accessGate(ctx, app, env, headers);
  if (!gate.ok) return gate.refusal ?? gatePage(ctx, app, env, gate.access, headers);
  if (gate.stripAuthorization) headers.delete('authorization');

  const identity = await identityFor(ctx, { method: c.req.method, url, headers }, app, env);
  if (isResponse(identity)) return identity;

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
