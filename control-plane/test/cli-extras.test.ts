import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseManifest } from '@microcloud/shared';
import tarStream from 'tar-stream';
import { controlHeaders } from '../src/volume-files.js';
import { ADMIN, TOML, createApp, harness, upload, type Harness } from './helpers.js';

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

const env = (name = 'main') => h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, name)!;
const get = (path: string) => h.request(`/v1/apps/crm${path}`, { key });

async function deploy(toml: string): Promise<number> {
  const parsed = parseManifest(toml, 'main');
  assert.deepEqual(parsed.errors, []);
  const snapshot = await upload(h, key, { 'boxlite.toml': toml, 'package.json': '{}', 'package-lock.json': '{}', 'server.js': '' });
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: parsed.manifest, base_version: h.ctx.store.latestSpecVersion(env().id), migrations: [] } });
  assert.equal(res.status, 202, await res.clone().text());
  await h.ctx.orchestrator.idle(env().id);
  return ((await res.json()) as { number: number }).number;
}

async function tgz(version: string): Promise<Buffer> {
  const pack = tarStream.pack();
  pack.entry({ name: 'package/package.json' }, JSON.stringify({ name: 'boxlite-app', version }));
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

/** A stand-in for the supervisor gateway: files under one volume, and the app's /healthz. */
async function fakeGateway(secret: string, control: string): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const files = new Map<string, string>([['/data/uploads/a.txt', 'hello']]);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    // As the real gateway: the control secret alone on /.boxlite/sv/*, the forwarding secret elsewhere.
    const allowed = u.pathname.startsWith('/.boxlite/sv/') ? req.headers['x-boxlite-control'] === control && !req.headers['x-boxlite-gateway'] : req.headers['x-boxlite-gateway'] === secret;
    if (!allowed) return void res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"gateway"}');
    if (u.pathname === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (u.pathname !== '/.boxlite/sv/files') return void res.writeHead(404).end();
    const p = u.searchParams.get('path')!;
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (files.has(p) && u.searchParams.get('overwrite') !== '1') return void res.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"exists"}');
        const replaced = files.has(p);
        files.set(p, Buffer.concat(chunks).toString());
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: p, bytes: Buffer.concat(chunks).length, replaced }));
      });
      return;
    }
    if (p === '/data/uploads') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: p, type: 'dir', entries: [{ name: 'a.txt', type: 'file', size: 5, mode: '-rw-r--r--', modified_at: '2026-10-21T10:00:00Z' }] }));
    const body = files.get(p);
    if (body === undefined) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no_such_file"}');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test('GET /cli/version reads the version from the served tarball', async () => {
  const missing = await h.request('/cli/version');
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: { next: string } }).error.next, /CLI_TGZ_PATH/);
  writeFileSync(join(h.dir, 'cli.tgz'), await tgz('0.3.1'));
  const res = await h.request('/cli/version');
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.version, '0.3.1');
  assert.equal(body.url, 'https://cp.test/cli/boxlite-app.tgz');
  assert.match(String(body.sha256), /^[0-9a-f]{64}$/);
});

test('whoami names the key, its scope and the latest CLI', async () => {
  writeFileSync(join(h.dir, 'cli.tgz'), await tgz('0.2.0'));
  const res = await get('/whoami');
  assert.equal(res.status, 200);
  const w = (await res.json()) as Record<string, any>;
  assert.equal(w.app, 'crm');
  assert.equal(w.key.last4, key.slice(-4));
  assert.equal(w.scope, 'app:crm');
  assert.deepEqual(w.environments, [{ name: 'main', status: 'new', url: h.ctx.resources.appUrl('crm', 'main') }]);
  assert.equal(w.cli.latest_version, '0.2.0');
  const me = await h.request('/v1/apps/me/whoami', { key });
  assert.equal(((await me.json()) as { app: string }).app, 'crm');
  assert.equal((await h.request('/v1/apps/crm/whoami', { key: 'bxl_app_wrong' })).status, 401);
});

test('context covers services, schedules, volumes, variables, deployments and next actions', async () => {
  const toml = `${TOML}\n[[volume]]\nname = "uploads"\nmount = "/data/uploads"\n\n[[schedule]]\nname = "daily"\ncron = "0 9 * * *"\ntarget = "web:/jobs/daily"\n\n[variables]\nLOG_LEVEL = "info"\n\n[secrets]\nOPENAI_API_KEY = "org/openai"\n`;
  h.ctx.store.run('INSERT INTO org_secrets (org_id, name, value, updated_at) VALUES (?, ?, ?, ?)', 'org_platform', 'org/openai', 'sk-real', new Date().toISOString());
  await deploy(toml);
  // The admin removed the secret after the deploy: the next start would lack OPENAI_API_KEY.
  h.ctx.store.run('DELETE FROM org_secrets WHERE name = ?', 'org/openai');
  h.ctx.store.appendLogs(env().id, [{ ts: new Date().toISOString(), source: 'web', level: 'error', line: 'TypeError: boom', deployment: 1 }]);
  const res = await get('/envs/main/context');
  assert.equal(res.status, 200, await res.clone().text());
  const c = (await res.json()) as Record<string, any>;
  assert.equal(c.status, 'live');
  assert.equal(c.urls.health, `${h.ctx.resources.appUrl('crm', 'main').replace(/\/+$/, '')}/healthz`);
  assert.deepEqual(c.services.map((s: any) => [s.name, s.exposed, s.health_path, s.state]), [['web', true, '/healthz', 'running']]);
  assert.equal(c.schedules[0].name, 'daily');
  assert.match(c.schedules[0].next_run, /T09:00:00\.000Z$/);
  assert.deepEqual(c.volumes, [{ name: 'uploads', mount: '/data/uploads', mode: 'rw' }]);
  const vars = Object.fromEntries(c.variables.map((v: any) => [v.name, v]));
  assert.equal(vars.LOG_LEVEL.value, 'info');
  assert.deepEqual([vars.OPENAI_API_KEY.value, vars.OPENAI_API_KEY.secret, vars.OPENAI_API_KEY.resolved], [null, true, false]);
  assert.equal(c.deployments[0].status, 'live');
  assert.deepEqual(c.recent_errors.map((e: any) => e.line), ['TypeError: boom']);
  assert.deepEqual(c.next_actions.map((f: any) => f.id), ['secret_missing', 'recent_errors']);
  assert.ok(!JSON.stringify(c).includes(env().forward_secret));
});

test('a failed deployment shows up as a classified next action', async () => {
  h.supervisor.failStart = true;
  await deploy(TOML);
  const c = (await (await get('/envs/main/context')).json()) as Record<string, any>;
  assert.equal(c.next_actions[0].id, 'deploy_failed');
  assert.match(c.next_actions[0].title, /#1 failed at start/);
  assert.match(c.next_actions[0].fix, /boxlite-app deploy/);
});

test('log search filters by level, source, deployment and time', async () => {
  const id = env().id;
  h.ctx.store.appendLogs(id, [
    { ts: '2026-10-21T10:00:00.000Z', source: 'web', level: 'info', line: 'GET / 200', deployment: 1 },
    { ts: '2026-10-21T10:01:00.000Z', source: 'web', level: 'error', line: 'boom', deployment: 1 },
    { ts: '2026-10-21T10:02:00.000Z', source: 'worker', level: 'error', line: 'tick failed', deployment: 2 },
  ]);
  const lines = async (q: string) => ((await (await get(`/envs/main/logs/search?${q}`)).json()) as { line: string }[]).map((l) => l.line);
  assert.deepEqual(await lines('level=error'), ['boom', 'tick failed']);
  assert.deepEqual(await lines('level=error&source=web'), ['boom']);
  assert.deepEqual(await lines('deployment=2'), ['tick failed']);
  assert.deepEqual(await lines('since=2026-10-21T10:00:30Z&until=2026-10-21T10:01:30Z'), ['boom']);
  assert.equal((await get('/envs/main/logs/search?level=loud')).status, 400);
});

test('the deployment timeline has step timestamps and every log line', async () => {
  const n = await deploy(TOML);
  const t = (await (await get(`/envs/main/deployments/${n}/timeline`)).json()) as Record<string, any>;
  assert.equal(t.deployment.status, 'live');
  const build = t.steps.find((s: any) => s.name === 'build');
  assert.ok(build.started_at && build.finished_at && build.finished_at >= build.started_at);
  assert.ok(t.logs.some((l: any) => /is live at/.test(l.line)), JSON.stringify(t.logs));
  assert.equal(t.truncated, false);
  assert.equal((await get('/envs/main/deployments/99/timeline')).status, 404);
});

test('db applied, and reset only on non-main with a snapshot first', async () => {
  h.ctx.store.updateEnv(env().id, { db_url: 'postgresql://u:p@ep.neon.test/neondb', neon_branch_id: 'br-main' });
  h.appdb.applied.push({ file: '0001_init.sql', sha256: 'a'.repeat(64), deployment: 1, applied_at: '2026-10-21T10:00:00.000Z' });
  assert.deepEqual(await (await get('/envs/main/db/applied')).json(), h.appdb.applied);

  const main = await h.request('/v1/apps/crm/envs/main/db/reset', { method: 'POST', key, json: {} });
  assert.equal(main.status, 403);
  assert.match(((await main.json()) as { error: { next: string } }).error.next, /db restore/);

  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  h.ctx.store.updateEnv(env('dev').id, { db_url: 'postgresql://u:p@ep-dev.neon.test/neondb' });
  const res = await h.request('/v1/apps/crm/envs/dev/db/reset', { method: 'POST', key, json: {} });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { reset: string; snapshot: string };
  assert.equal(body.reset, 'dev');
  assert.deepEqual(h.appdb.queries.at(-1), { statements: ['DROP SCHEMA IF EXISTS public CASCADE', 'CREATE SCHEMA public'], write: true });
  const snaps = (await (await get('/envs/dev/db/snapshots')).json()) as { id: string; message: string }[];
  assert.deepEqual(snaps.map((s) => [s.id, s.message]), [[body.snapshot, 'before db reset']]);
});

test('vars and schedules list the live spec', async () => {
  h.ctx.store.run('INSERT INTO org_secrets (org_id, name, value, updated_at) VALUES (?, ?, ?, ?)', 'org_platform', 'org/openai', 'sk-real', new Date().toISOString());
  await deploy(`${TOML}\n[[schedule]]\nname = "daily"\ncron = "0 9 * * *"\ntarget = "web:/jobs/daily"\n\n[secrets]\nOPENAI_API_KEY = "org/openai"\n`);
  const vars = (await (await get('/envs/main/vars')).json()) as { name: string; value: string | null; resolved: boolean; source: string }[];
  const secret = vars.find((v) => v.name === 'OPENAI_API_KEY')!;
  assert.deepEqual([secret.value, secret.resolved, secret.source], [null, true, 'secret org/openai']);
  assert.ok(!JSON.stringify(vars).includes('sk-real'));
  const schedules = (await (await get('/envs/main/schedules')).json()) as { name: string; last_run: string | null }[];
  assert.deepEqual(schedules.map((s) => [s.name, s.last_run]), [['daily', null]]);
});

test('volume files go through the Box gateway with the secret, confined to the volume', async () => {
  await deploy(`${TOML}\n[[volume]]\nname = "uploads"\nmount = "/data/uploads"\n`);
  const gw = await fakeGateway(env().forward_secret, env().control_secret);
  try {
    h.ctx.store.updateEnv(env().id, { box_url: gw.url });
    assert.deepEqual(await (await get('/envs/main/volumes')).json(), [{ name: 'uploads', mount: '/data/uploads', mode: 'rw' }]);

    const listing = (await (await get('/envs/main/volumes/uploads/files?path=/')).json()) as Record<string, any>;
    assert.equal(listing.path, '/');
    assert.equal(listing.entries[0].name, 'a.txt');

    const file = await get('/envs/main/volumes/uploads/files?path=/a.txt');
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await file.text(), 'hello');

    const missing = await get('/envs/main/volumes/uploads/files?path=/nope.txt');
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: { next: string } }).error.next, /volume ls uploads:\//);

    const escape = await get('/envs/main/volumes/uploads/files?path=/../../etc/passwd');
    assert.equal(escape.status, 403);
    assert.equal((await get('/envs/main/volumes/other/files?path=/')).status, 404);

    const put = (path: string) => h.request(`/v1/apps/crm/envs/main/volumes/uploads/files?path=${path}`, { method: 'PUT', key, body: 'PNG', headers: { 'content-type': 'application/octet-stream' } });
    const created = await put('/logo.png');
    assert.deepEqual(await created.json(), { volume: 'uploads', path: '/logo.png', bytes: 3, replaced: false });
    const conflict = await put('/logo.png');
    assert.equal(conflict.status, 409);
    assert.match(((await conflict.json()) as { error: { next: string } }).error.next, /--force/);
    assert.equal((await put('/logo.png&overwrite=1')).status, 200);
    assert.ok(gw.seen.includes('GET /.boxlite/sv/files?path=%2Fdata%2Fuploads%2Fa.txt'));
    assert.ok(!gw.seen.some((s) => s.includes('etc')));
  } finally {
    gw.server.close();
  }
});

test('an old supervisor without the files endpoint is reported as such', async () => {
  await deploy(`${TOML}\n[[volume]]\nname = "uploads"\nmount = "/data/uploads"\n`);
  const old = createServer((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}'));
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r));
  try {
    h.ctx.store.updateEnv(env().id, { box_url: `http://127.0.0.1:${(old.address() as AddressInfo).port}` });
    const res = await get('/envs/main/volumes/uploads/files?path=/');
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_supported_yet');
  } finally {
    old.close();
  }
});

test('probe GETs the health path through the proxy path and reports not_deployed before a deploy', async () => {
  const before = (await (await get('/envs/main/probe')).json()) as Record<string, unknown>;
  assert.deepEqual([before.reason, before.ok], ['not_deployed', false]);
  await deploy(TOML);
  const gw = await fakeGateway(env().forward_secret, env().control_secret);
  try {
    h.ctx.store.updateEnv(env().id, { box_url: gw.url });
    const p = (await (await get('/envs/main/probe')).json()) as Record<string, unknown>;
    assert.deepEqual([p.path, p.status, p.ok, p.reason, p.body_head], ['/healthz', 200, true, 'ok', 'ok']);
    assert.ok(gw.seen.includes('GET /healthz'));
  } finally {
    gw.server.close();
  }
  assert.equal((await h.request('/v1/apps/crm/envs/main/probe', { key: ADMIN })).status, 200);
});

test('volume calls carry exactly one secret: the control secret', () => {
  const e = env();
  assert.ok(e.control_secret && e.control_secret !== e.forward_secret);
  assert.deepEqual(controlHeaders(e), { 'x-boxlite-control': e.control_secret });
});

test('context reads the services live, so a crash that starts after go-live is a next action', async () => {
  await deploy(TOML);
  // Live, web started crashing: the stored report from the deployment still says it was running.
  h.supervisor.health = async () => ({ ok: true, deployment: 1, services: [{ name: 'web', state: 'restarting', health: 'none', port: 20001, pid: null, restarts: 12, last_exit_code: 1 }] });
  const c = (await (await get('/envs/main/context')).json()) as Record<string, any>;
  assert.deepEqual(c.services.map((s: any) => [s.name, s.state, s.restarts, s.last_exit_code]), [['web', 'restarting', 12, 1]]);
  assert.equal(c.next_actions[0].id, 'crash_loop');
});

test('feedback: an agent reports a platform problem; the platform admin reads it, keys redacted; floods are capped', async () => {
  const res = await h.request('/v1/apps/crm/feedback', { method: 'POST', key, json: { message: `deploy hung at "box" for 10 minutes, key ${key} in my shell`, command: 'boxlite-app deploy', env: 'main', cli_version: '0.2.0' } });
  assert.equal(res.status, 201, await res.clone().text());
  const got = (await res.json()) as { id: string; next: string };
  assert.match(got.id, /^fb_/);
  assert.match(got.next, /workaround/);

  const list = await h.request('/admin/feedback', { headers: { authorization: `Bearer ${ADMIN}` } });
  const rows = (await list.json()) as { id: string; app: string; env: string; actor: string; message: string; command: string }[];
  const mine = rows.find((r) => r.id === got.id)!;
  assert.equal(mine.app, 'crm');
  assert.equal(mine.command, 'boxlite-app deploy');
  assert.match(mine.actor, /^key:…/);
  assert.ok(!mine.message.includes(key), 'the App key is redacted from the stored report');

  assert.equal((await h.request('/v1/apps/crm/feedback', { method: 'POST', key, json: { message: 'short' } })).status, 400);
  let last = 0;
  for (let i = 0; i < 25 && last !== 429; i++) last = (await h.request('/v1/apps/crm/feedback', { method: 'POST', key, json: { message: `report number ${i} about the platform` } })).status;
  assert.equal(last, 429, 'more than 20 reports an hour are refused');
});
