import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { NodeListeners, deriveOriginUrl, isLocalUrl } from '../src/origins.js';
import { createTestSession } from '../src/enduser/management.js';
import { isResponse } from '../src/http/response.js';
import { handleUpgrade } from '../src/proxy/upgrade.js';
import { createApp, harness, type Harness } from './helpers.js';

test('origin URLs are derived from the API origin', () => {
  assert.equal(deriveOriginUrl('https://8080-d-1a2b3c.proxy.dev.boxlite.ai', 10001), 'https://10001-d-1a2b3c.proxy.dev.boxlite.ai');
  assert.equal(deriveOriginUrl('https://8080-d-1a2b3c.proxy.dev.boxlite.ai', 8081), 'https://8081-d-1a2b3c.proxy.dev.boxlite.ai');
  assert.equal(deriveOriginUrl('http://localhost:8787', 10002), 'http://localhost:10002');
  assert.equal(deriveOriginUrl('http://127.0.0.1:8787', 10002), 'http://127.0.0.1:10002');
  assert.equal(deriveOriginUrl('https://cp.test', 10001), 'https://10001-cp.test');
  assert.ok(isLocalUrl('http://localhost:8787'));
  assert.ok(!isLocalUrl('https://8080-d-1.proxy.dev.boxlite.ai'));
});

async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) {
    const s = netServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

let h: Harness | undefined;
let listeners: NodeListeners | undefined;
let upstream: Server | undefined;
after(async () => {
  await listeners?.close();
  upstream?.close();
  h?.close();
});

test('real listeners: one per origin, routed by the port the request arrived on (local dev URLs)', async () => {
  const [api, consolePort, envPort] = await freePorts(3);
  upstream = createServer((req, res) => res.end(`app saw ${req.url} host=${req.headers['x-forwarded-host']}`));
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
  h = harness({ port: api!, consolePort, publicUrl: `http://localhost:${api}`, envPorts: { min: envPort!, max: envPort! } });
  await createApp(h);
  const app = h.ctx.store.appByName('crm')!;
  const env = h.ctx.store.envByName(app.id, 'main')!;
  // A Box that exists: the proxy answers "not running" for one BoxLite does not know.
  const box = await h.boxlite.createBox({ name: 'app-crm-main' } as never);
  h.ctx.store.updateEnv(env.id, { box_id: box.id, box_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, live_deployment: 1, access_override: 'public' });
  assert.equal(h.appUrl(), `http://localhost:${envPort}`, 'local dev: localhost URLs, no tunnels');

  listeners = new NodeListeners(h.app.fetch, (req, socket, head, port) => void handleUpgrade(h!.ctx, req, socket, head, port), '127.0.0.1');
  await listeners.listen(api!);
  await h.ctx.origins.boot(listeners);
  assert.deepEqual(listeners.ports.sort(), [api, consolePort, envPort].sort());
  assert.deepEqual(h.tunnels, [], 'no tunnels in local dev');

  const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  assert.equal(await (await get(api!, '/healthz')).text(), 'ok');
  assert.equal(await (await get(envPort!, '/healthz')).text(), `app saw /healthz host=127.0.0.1:${envPort}`);
  const toConsole = await get(api!, '/console/');
  assert.equal(toConsole.status, 302);
  assert.equal(toConsole.headers.get('location'), `http://localhost:${consolePort}/console/`);
  assert.equal((await get(consolePort!, '/')).headers.get('location'), '/console/');
  assert.equal((await get(consolePort!, '/healthz')).status, 404);
  const legacy = await get(api!, '/crm/x');
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), `http://localhost:${envPort}/x`);

  // Under @hono/node-server, Response.json() is not `instanceof Response` (the global is swapped).
  // A signed-in /.boxlite/auth/me answered with Response.json and used to be forwarded to the app.
  assert.ok(isResponse(Response.json({})));
  h.ctx.store.run("INSERT INTO spec_versions (env_id, version, deployment, spec, created_at) VALUES (?, 1, 1, ?, '2026-01-01')", env.id, JSON.stringify({ app: 'crm', environment: 'main', version: 1, services: [], schedules: [], volumes: [], auth: { providers: ['github'], protect: [] } }));
  const { cookie } = await createTestSession(h.ctx, app, h.ctx.store.envById(env.id)!, 'qa@example.com', 'test');
  const me = await fetch(`http://127.0.0.1:${envPort}/.boxlite/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200, 'the CP answers /.boxlite/auth/me itself');
  assert.equal(((await me.json()) as { email: string }).email, 'qa@example.com');
});
