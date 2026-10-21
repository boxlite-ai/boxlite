import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { serve } from '@hono/node-server';
import { handleUpgrade } from '../src/routes/proxy.js';
import { createApp, harness } from './helpers.js';

const h = harness();
let upstream: Server;
let cp: Server;
const sockets: import('node:stream').Duplex[] = [];
after(() => {
  for (const s of sockets) s.destroy();
  upstream?.closeAllConnections();
  upstream?.close();
  cp?.closeAllConnections();
  cp?.close();
  h.close();
});

test('WebSocket upgrades on an app origin are spliced through at the same path with the gateway header', async () => {
  let seenHeaders: Record<string, unknown> = {};
  let seenUrl = '';
  upstream = createServer();
  upstream.on('upgrade', (req, socket) => {
    seenHeaders = req.headers;
    seenUrl = req.url!;
    sockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d}`));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  await createApp(h);
  const app = h.ctx.store.appByName('crm')!;
  const env = h.ctx.store.envByName(app.id, 'main')!;
  h.ctx.store.updateEnv(env.id, { box_id: 'b', box_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, live_deployment: 1, access_override: 'public' });

  cp = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise((r) => setTimeout(r, 50));
  // As if this socket were the env's own listener (origins.ts tags every request with its port).
  const envPort = h.appPort();
  cp.on('upgrade', (req, socket, head) => void handleUpgrade(h.ctx, req, socket, head, envPort));
  const port = (cp.address() as AddressInfo).port;

  const reply = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/ws?room=1', headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => {
      assert.equal(res.statusCode, 101);
      socket.write('hi');
      socket.once('data', (d) => {
        resolve(String(d));
        socket.destroy();
      });
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(reply, 'echo:hi');
  assert.equal(seenUrl, '/ws?room=1');
  assert.equal(seenHeaders['x-boxlite-gateway'], env.gateway_secret);
  assert.equal(seenHeaders['x-forwarded-prefix'], undefined);
  assert.equal(seenHeaders['x-forwarded-host'], `127.0.0.1:${port}`);
});
