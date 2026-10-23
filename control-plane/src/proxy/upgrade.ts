/** WebSocket (any HTTP Upgrade) on an app origin: the same gate, sign-in and headers as HTTP, then the sockets are spliced. */
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Ctx } from '../ctx.js';
import { identityFor } from '../enduser/app-origin.js';
import { normalisePath } from '../enduser/paths.js';
import { isResponse } from '../http/response.js';
import { forwardHeaders } from '../supervisor.js';
import { appCookies, isPlatformHeader } from './forward.js';
import { accessGate } from './gate.js';

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
  const gate = accessGate(ctx, app, env, incoming, url.pathname);
  if (!gate.ok) return reject(401, 'Unauthorized');
  if (normalisePath(url.pathname).toLowerCase().startsWith('/.boxlite')) return reject(404, 'Not Found');
  const identity = await identityFor(ctx, { method: req.method ?? 'GET', url, headers: incoming }, app, env);
  if (isResponse(identity)) return reject(identity.status, identity.status === 401 ? 'Unauthorized' : identity.status === 404 ? 'Not Found' : 'Forbidden');
  // Like an HTTP request, a WebSocket to a sleeping app wakes it; the client reconnects once it runs.
  if (env.box_id && (await ctx.resources.boxStatus(env.box_id).catch(() => 'unknown')) === 'stopped') {
    if (!ctx.resources.wakeFailure(env.box_id)) void ctx.resources.wake(env.box_id);
    return reject(503, 'Service Unavailable');
  }
  const target = new URL(env.box_url + url.pathname + url.search);
  const origin = new URL(ctx.resources.appUrl(app.name, env.name));
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || isPlatformHeader(k)) continue;
    if (k === 'authorization' && gate.stripAuthorization) continue;
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
