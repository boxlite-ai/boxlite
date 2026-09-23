import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { JsBoxlite, JsBoxliteRestOptions } = await import(
  process.env.BOXLITE_NODE_NATIVE_LOADER
    ? pathToFileURL(process.env.BOXLITE_NODE_NATIVE_LOADER).href
    : new URL('../../native/boxlite.js', import.meta.url).href
);

assert.equal(typeof global.gc, 'function');
const pending = [];
let arrived;
const allArrived = new Promise(resolve => { arrived = resolve; });
const server = createServer(async (req, res) => {
  for await (const chunk of req) { /* Consume config before retaining the response. */ }
  res.setHeader('Content-Type', 'application/json');
  if (/\/ssh(?:\/|$)/.test(req.url)) {
    pending.push(res);
    if (pending.length === 6) arrived();
  } else {
    res.end(JSON.stringify({ box_id: 'ssh-test', name: null, status: 'running', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', image: 'alpine', cpus: 1, memory_mib: 256 }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const runtime = JsBoxlite.rest(new JsBoxliteRestOptions(`http://127.0.0.1:${server.address().port}`));
try {
  let box = await runtime.get('ssh-test');
  let ssh = box.ssh;
  const weak = new WeakRef(ssh);
  const results = Promise.allSettled(Array.from({length: 2}, () => [
    ssh.configure({listenAddress: 'addr', hostPrivateKey: 'sentinel-private', accounts: []}),
    ssh.status(), ssh.disable(),
  ]).flat());
  ssh = null;
  box = null;
  await allArrived;
  for (let i = 0; i < 5; i++) { await setImmediate(); global.gc(); }
  assert.ok(weak.deref(), 'pending async methods must retain their receiver');
  for (let i = 0; i < pending.length; i++) {
    if (i === 0) {
      pending[i].statusCode = 400;
      pending[i].end(JSON.stringify({error: {code: 'invalid_argument', message: 'sentinel-private'}}));
    } else {
      pending[i].end('{"enabled":true,"generation":18446744073709551615,"listen_address":"addr","host_public_key":"public","host_key_fingerprint":"fp"}');
    }
  }
  const settled = await results;
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 5);
  for (const result of settled) {
    if (result.status === 'fulfilled') assert.equal(result.value.generation, 18446744073709551615n);
    else {
      assert.match(result.reason.message, /SSH request failed/);
      assert.doesNotMatch(result.reason.message, /sentinel/);
    }
  }
  const deadline = Date.now() + 5000;
  let collected = false;
  while (Date.now() < deadline) {
    await setImmediate();
    global.gc();
    if (weak.deref() === undefined) { collected = true; break; }
  }
  assert.ok(collected, 'completed promises must release their receiver');
} finally {
  runtime.close();
  for (const response of pending) response.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
