import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { filterSetCookie, rewriteLocation } from '../src/proxy/forward.js';
import { ADMIN, API_PORT, CONSOLE_PORT, createApp, harness, type Harness } from './helpers.js';

let upstream: Server;
let upstreamUrl: string;
let seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    if (req.url === '/go-login') {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    if (req.url === '/go-abs') {
      res.writeHead(302, { location: `${upstreamUrl}/dash?x=1` });
      return res.end();
    }
    if (req.url === '/cookies') {
      res.writeHead(200, {
        'set-cookie': ['sid=1; Path=/; HttpOnly', 'bxl_console=evil; Path=/console', 'BXL_access=x', '__Host-bxl_session=y; Path=/; Secure', 'wide=1; Domain=proxy.test; Path=/', 'theme=dark'],
      });
      return res.end('ok');
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'sid=1; Path=/' });
    res.end(`path=${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(() => upstream.close());

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
  seen = [];
  // Pretend #1 is live on a running Box whose tunnel is the local upstream.
  const box = await h.boxlite.createBox({ name: 'app-crm-main' } as never);
  h.ctx.store.updateEnv(env().id, { box_id: box.id, box_url: upstreamUrl, live_deployment: 1, access_override: 'public' });
});

const env = (app = 'crm', name = 'main') => h.ctx.store.envByName(h.ctx.store.appByName(app)!.id, name)!;

/** A second app `ledger`, live on the same upstream. */
async function secondApp(): Promise<string> {
  const k = await createApp(h, 'ledger');
  const box = await h.boxlite.createBox({ name: 'app-ledger-main' } as never);
  h.ctx.store.updateEnv(env('ledger').id, { box_id: box.id, box_url: upstreamUrl, live_deployment: 1, access_override: 'private' });
  return k;
}

// ---- origins and ports ---------------------------------------------------------------

test('each env gets its own port and origin; the tunnel is registered on the CP Box', async () => {
  await secondApp();
  const crm = h.appPort('crm');
  const ledger = h.appPort('ledger');
  assert.deepEqual([crm, ledger], [10001, 10002]);
  assert.equal(h.appUrl('crm'), 'https://10001-cp.test');
  assert.equal(h.appUrl('ledger'), 'https://10002-cp.test');
  await h.ctx.origins.settled();
  assert.ok(h.tunnels.includes(10001) && h.tunnels.includes(10002), JSON.stringify(h.tunnels));
  // Everything that reports the URL reports the origin.
  const status = (await (await h.request('/v1/apps/crm', { key })).json()) as { url: string };
  assert.equal(status.url, 'https://10001-cp.test');
  assert.equal(h.ctx.resources.runtimeEnv(h.ctx.store.appByName('crm')!, env(), undefined).BOXLITE_APP_URL, 'https://10001-cp.test');
  assert.equal(h.ctx.origins.roleOf(10001).kind, 'app');
  assert.equal(h.ctx.origins.roleOf(API_PORT).kind, 'api');
  assert.equal(h.ctx.origins.roleOf(CONSOLE_PORT).kind, 'console');
  assert.equal(h.ctx.origins.roleOf(10500).kind, 'unassigned');
});

test('a registered tunnel URL wins over the derived one', async () => {
  h.close();
  h = harness();
  h.ctx.registerTunnel = async (p) => `https://t${p}.tunnels.test/`;
  await createApp(h);
  await h.ctx.origins.settled();
  assert.equal(h.appUrl(), 'https://t10001.tunnels.test');
});

test('a freed port is not handed out again right away', async () => {
  await secondApp();
  assert.equal(h.appPort('ledger'), 10002);
  h.ctx.store.run('DELETE FROM envs WHERE id = ?', env('ledger').id);
  const k = await createApp(h, 'third');
  assert.ok(k);
  assert.equal(h.appPort('third'), 10003);
});

test('the local port decides the role: the same path means different things on each origin', async () => {
  // App origin: everything is the app's, including paths the CP uses on its API origin.
  for (const path of ['/v1/apps/crm', '/console/api/apps', '/auth/callback/github', '/healthz', '/sv/v1/spec']) {
    const res = await h.appRequest(path, { key });
    assert.equal(await res.text(), `path=${path}`, path);
  }
  // API origin: CP routes, and no app.
  assert.equal((await h.request('/healthz')).status, 200);
  assert.equal(await (await h.request('/healthz')).text(), 'ok');
  assert.equal((await h.request('/.boxlite/open?t=x')).status, 404);
  // Console origin: only /console.
  assert.equal((await h.request('/v1/apps/crm', { key, port: CONSOLE_PORT })).status, 404);
  const root = await h.request('/', { port: CONSOLE_PORT });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/console/');
  // /console on the API origin is sent to the console origin.
  const moved = await h.request('/console/dashboard/apps?x=1', { port: API_PORT });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), 'https://8081-cp.test/console/dashboard/apps?x=1');
  // A port nobody owns.
  assert.equal((await h.request('/', { port: 10999 })).status, 404);
});

// ---- forwarding ----------------------------------------------------------------------

test('the app lives at / of its origin: path as-is, gateway and forwarding headers, no prefix', async () => {
  const res = await h.appRequest('/api/items?q=1', { headers: { 'x-boxlite-user-email': 'spoof@x', 'x-forwarded-prefix': '/x', cookie: '__Host-bxl_access=abc; __Host-bxl_session=s; bxl_session=s2; theme=dark' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'path=/api/items?q=1');
  const got = seen[0]!.headers;
  assert.equal(got['x-boxlite-gateway'], env().forward_secret);
  assert.equal(got['x-forwarded-prefix'], undefined);
  assert.equal(got['x-forwarded-host'], '10001-cp.test');
  assert.equal(got['x-forwarded-proto'], 'https');
  assert.equal(got['x-boxlite-user-email'], undefined);
  assert.equal(got.cookie, 'theme=dark', 'platform cookies never reach the app');
  assert.equal(res.headers.get('set-cookie'), 'sid=1; Path=/', 'cookie paths are left alone');
});

test('Location: relative stays, the Box tunnel URL becomes the env origin', async () => {
  const rel = await h.appRequest('/go-login');
  assert.equal(rel.status, 302);
  assert.equal(rel.headers.get('location'), '/login');
  const abs = await h.appRequest('/go-abs');
  assert.equal(abs.headers.get('location'), 'https://10001-cp.test/dash?x=1');
  assert.equal(rewriteLocation('https://box', 'https://box', 'https://app'), 'https://app/');
  assert.equal(rewriteLocation('https://elsewhere/x', 'https://box', 'https://app'), 'https://elsewhere/x');
});

test('F9: an app cannot set platform cookies or cookies with a Domain', async () => {
  const res = await h.appRequest('/cookies');
  assert.deepEqual(res.headers.getSetCookie(), ['sid=1; Path=/; HttpOnly', 'theme=dark']);
  assert.equal(filterSetCookie('a=1; domain=.x.test'), null);
  assert.equal(filterSetCookie('a=1; Domain'), null);
  assert.equal(filterSetCookie('bxl_x=1'), null);
  assert.equal(filterSetCookie('__Secure-BXL_x=1; Secure'), null);
  assert.equal(filterSetCookie('mydomain=1; Path=/'), 'mydomain=1; Path=/');
  assert.equal(filterSetCookie('=1'), null);
});

// ---- access gate -----------------------------------------------------------------------

test('public_paths let a webhook into a private app; nothing else gets in, however the path is spelled', async () => {
  const e = env();
  h.ctx.store.updateEnv(e.id, { access_override: 'private' });
  h.ctx.store.insertSpec(e.id, {
    app: 'crm', environment: 'main', version: 1, deployment: 1, base_version: 0,
    runtime: { image: 'node', size: 'small', build: [], output: null },
    services: [{ name: 'web', command: 'node s.js', port: 3000 }], schedules: [],
    database: null, volumes: [], auth: null, domains: { builtin: 'crm', custom: [] }, access: 'private', public_paths: ['/webhooks/*'], variables: {}, secrets: {},
    assigned: { box_id: e.box_id, box_url: e.box_url, db_host: null, db_branch: null, app_url: h.appUrl() },
  } as never);
  const hook = await h.appRequest('/webhooks/stripe', { method: 'POST', body: '{"type":"checkout.session.completed"}', headers: { 'content-type': 'application/json' } });
  assert.equal(hook.status, 200, 'the provider reaches the webhook without a key or cookie');
  assert.equal(seen.at(-1)?.url, '/webhooks/stripe');
  for (const p of ['/admin', '/webhooks/../admin', '/webhooks/%2e%2e/admin', '/x/webhooks/stripe']) {
    assert.equal((await h.appRequest(p)).status, 401, `${p} stays private`);
  }
});

test('a private app answers 401 with what happened and how to get in; ?__key= no longer opens it', async () => {
  h.ctx.store.updateEnv(env().id, { access_override: 'private' });
  const html = await h.appRequest('/page', { headers: { accept: 'text/html' } });
  assert.equal(html.status, 401);
  const text = await html.text();
  assert.match(text, /This site is private/);
  // Visitors see no App, environment or key; its owner gets one link to the console.
  assert.ok(!/\bcrm\b[^/?]/.test(text.replace(/href="[^"]*"/g, '')), 'the App name stays off the page');
  assert.ok(!text.includes('Authorization'), 'no agent instructions for visitors');
  assert.match(text, /href="https:\/\/8081-cp\.test\/console\/dashboard\/apps\/crm\?tab=overview"/);
  assert.match(text, /Hosted on/);
  const json = await h.appRequest('/api/x');
  assert.equal(json.status, 401);
  assert.equal(((await json.json()) as { error: { code: string } }).error.code, 'unauthenticated');
  const withKey = await h.appRequest(`/page?__key=${key}`);
  assert.equal(withKey.status, 401);
  assert.equal(withKey.headers.get('set-cookie'), null);
  assert.equal(seen.length, 0);
});

test('Bearer App key: own key passes and is stripped; another app\'s key is 401; other schemes pass through', async () => {
  const ledgerKey = await secondApp();
  // ledger is private.
  const ok = await h.appRequest('/report', { key: ledgerKey }, 'ledger');
  assert.equal(ok.status, 200);
  assert.equal(seen[0]!.headers.authorization, undefined, 'the App key never reaches app code');
  seen = [];
  const wrong = await h.appRequest('/report', { key }, 'ledger');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /does not open ledger/);
  assert.equal(seen.length, 0, 'not forwarded');
  // On a public app too: a foreign App key is refused, never handed to the app.
  assert.equal((await h.appRequest('/x', { key: ledgerKey })).status, 401);
  assert.equal((await h.appRequest('/x', { headers: { authorization: 'Bearer bxl_app_unknown' } })).status, 401);
  assert.equal(seen.length, 0);
  // The app's own auth scheme is untouched.
  const own = await h.appRequest('/x', { headers: { authorization: 'Bearer my-app-jwt' } });
  assert.equal(own.status, 200);
  assert.equal(seen[0]!.headers.authorization, 'Bearer my-app-jwt');
  // A non-bxl header on a private app does not pass the gate.
  assert.equal((await h.appRequest('/report', { headers: { authorization: 'Bearer my-app-jwt' } }, 'ledger')).status, 401);
  // The admin token opens any app and is stripped too.
  seen = [];
  assert.equal((await h.appRequest('/report', { key: ADMIN }, 'ledger')).status, 200);
  assert.equal(seen[0]!.headers.authorization, undefined);
});

test('open tickets: single use, 60 s, stored hashed, bound to their env, set a host-only access cookie', async () => {
  await secondApp();
  const res = await h.request('/v1/apps/ledger/envs/main/open-ticket', { method: 'POST', key: ADMIN, json: { next: '/deals?x=1' } });
  assert.equal(res.status, 201);
  const { url, expires_at } = (await res.json()) as { url: string; expires_at: string };
  const u = new URL(url);
  assert.equal(u.origin, 'https://10002-cp.test');
  assert.equal(u.pathname, '/.boxlite/open');
  assert.equal(u.searchParams.get('next'), '/deals?x=1');
  const ticket = u.searchParams.get('t')!;
  assert.ok(Math.abs(Date.parse(expires_at) - Date.now() - 60_000) < 5000);
  assert.equal(JSON.stringify(h.ctx.store.all('SELECT * FROM open_tickets')).includes(ticket), false, 'only the hash is stored');

  // Not on another env's origin.
  assert.equal((await h.appRequest(`/.boxlite/open?t=${ticket}`)).status, 401);
  const open = await h.appRequest(u.pathname + u.search, {}, 'ledger');
  assert.equal(open.status, 302);
  assert.equal(open.headers.get('location'), '/deals?x=1');
  assert.equal(open.headers.get('referrer-policy'), 'no-referrer');
  const set = open.headers.get('set-cookie')!;
  assert.match(set, /^__Host-bxl_access=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
  assert.doesNotMatch(set, /Domain/i);
  const cookie = set.split(';')[0]!;
  assert.equal((await h.appRequest('/deals', { headers: { cookie } }, 'ledger')).status, 200);
  assert.equal(seen.at(-1)!.headers.cookie, undefined, 'the access cookie is not forwarded');

  // Single use.
  const again = await h.appRequest(u.pathname + u.search, {}, 'ledger');
  assert.equal(again.status, 401);
  assert.match(await again.text(), /This link has expired/);
  // Expired.
  const late = (await (await h.request('/v1/apps/ledger/envs/main/open-ticket', { method: 'POST', key: ADMIN })).json()) as { url: string };
  h.ctx.store.run('UPDATE open_tickets SET expires_at = ? WHERE used_at IS NULL', new Date(Date.now() - 1000).toISOString());
  const lu = new URL(late.url);
  assert.equal(lu.searchParams.get('next'), '/');
  assert.equal((await h.appRequest(lu.pathname + lu.search, {}, 'ledger')).status, 401);
  // A forged or other env's cookie does nothing.
  assert.equal((await h.appRequest('/deals', { headers: { cookie: `__Host-bxl_access=${env().id}.9999999999.forged` } }, 'ledger')).status, 401);
  const { signAccess } = await import('../src/proxy/gate.js');
  assert.equal((await h.appRequest('/deals', { headers: { cookie: `__Host-bxl_access=${signAccess('test-session-secret', env().id)}` } }, 'ledger')).status, 401);
  // A bad next is refused at creation; an App key only opens its own app.
  assert.equal((await h.request('/v1/apps/ledger/envs/main/open-ticket', { method: 'POST', key: ADMIN, json: { next: '//evil.test' } })).status, 400);
  assert.equal((await h.request('/v1/apps/ledger/envs/main/open-ticket', { method: 'POST', key })).status, 403);
});

test('an off-site next on the open link falls back to /', async () => {
  const { url } = (await (await h.request('/v1/apps/crm/envs/main/open-ticket', { method: 'POST', key })).json()) as { url: string };
  const u = new URL(url);
  const res = await h.appRequest(`/.boxlite/open?t=${u.searchParams.get('t')}&next=${encodeURIComponent('https://evil.test/')}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
});

// ---- old prefix URLs --------------------------------------------------------------------

test('old path-prefix URLs on the API origin answer 301 to the env origin, dropping ?__key=', async () => {
  const res = await h.request('/crm/page?x=1&__key=bxl_app_abc');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://10001-cp.test/page?x=1');
  assert.equal((await h.request('/crm')).headers.get('location'), 'https://10001-cp.test/');
  h.ctx.store.run("INSERT INTO envs (id, app_id, name, created_at, forward_secret) SELECT 'env_dev', app_id, 'dev', created_at, 'g2' FROM envs WHERE name = 'main'");
  assert.equal((await h.request('/crm--dev/a/b')).headers.get('location'), 'https://10002-cp.test/a/b');
  assert.equal((await h.request('/nope/')).status, 404);
  assert.equal((await h.request('/v1/unknown')).status, 404);
  assert.equal(seen.length, 0);
});

// ---- wake, schedules, binaries ----------------------------------------------------------

test('a stopped Box is started and the visitor gets a Starting page', async () => {
  h.boxlite.boxes.get(env().box_id!)!.status = 'stopped';
  const res = await h.appRequest('/', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '3');
  const html = await res.text();
  assert.match(html, /Just a moment/);
  assert.match(html, /http-equiv="refresh" content="3"/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.boxlite.calls.includes(`start ${env().box_id}`));
  assert.equal(seen.length, 0);
});

test('a due schedule is sent as POST to the app and logged', async () => {
  const e = env();
  const spec = {
    app: 'crm', environment: 'main', version: 1, deployment: 1, base_version: 0,
    runtime: { image: 'node', size: 'small', build: [], output: null },
    services: [{ name: 'web', command: 'node s.js', port: 3000 }],
    schedules: [{ name: 'nightly', cron: '* * * * *', target: 'web:/jobs/nightly' }],
    database: null, volumes: [], auth: null, domains: { builtin: 'crm', custom: [] }, access: 'private', variables: {}, secrets: {},
    assigned: { box_id: e.box_id, box_url: e.box_url, db_host: null, db_branch: null, app_url: h.appUrl() },
  };
  h.ctx.store.insertSpec(e.id, spec as never);
  h.ctx.store.insertDeployment(
    { kind: 'deploy', status: 'live', message: null, by: 'test', created_at: new Date().toISOString(), started_at: null, finished_at: null, spec_version: 1, base_version: 0, snapshot_id: null, steps: [], changes: [], error: null, request: { kind: 'deploy' }, idempotency_key: null, release: 1, box_id: e.box_id, built: true, restore_point: null, live_at: new Date(Date.now() - 120_000).toISOString() },
    e.id,
  );
  await h.ctx.scheduler.tick();
  const hit = seen.find((s) => s.url === '/jobs/nightly');
  assert.ok(hit, JSON.stringify(seen.map((s) => s.url)));
  assert.equal(hit.headers['x-boxlite-schedule'], 'nightly');
  assert.equal(hit.headers['x-boxlite-gateway'], e.forward_secret);
  assert.equal(hit.headers['x-forwarded-host'], '10001-cp.test');
  const logs = h.ctx.store.logs(e.id, { source: 'schedule' });
  assert.match(logs[0]!.line, /nightly: POST \/jobs\/nightly → 200/);
  // Just ran: not due again on the next tick.
  seen = [];
  await h.ctx.scheduler.tick();
  assert.equal(seen.length, 0);
});

test('supervisor binaries are served, symlinks included', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  mkdirSync(h.ctx.config.svBinDir, { recursive: true });
  writeFileSync(`${h.ctx.config.svBinDir}/supervisor-linux-amd64`, 'ELF');
  symlinkSync('supervisor-linux-amd64', `${h.ctx.config.svBinDir}/supervisor-linux-x86_64`);
  for (const f of ['supervisor-linux-amd64', 'supervisor-linux-x86_64']) {
    const res = await h.request(`/sv/bin/${f}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ELF');
  }
  assert.equal((await h.request('/sv/bin/..%2Fcp.sqlite')).status, 404);
});

test('a 503 service_unavailable from the gateway shows the Starting page', async () => {
  const up = (await import('node:http')).createServer((_q, s) => {
    s.writeHead(503, { 'retry-after': '3', 'content-type': 'application/json' });
    s.end('{"error":"service_unavailable"}');
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  h.ctx.store.updateEnv(env().id, { box_url: `http://127.0.0.1:${(up.address() as AddressInfo).port}` });
  const res = await h.appRequest('/');
  up.close();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-boxlite-starting'), '1');
});
