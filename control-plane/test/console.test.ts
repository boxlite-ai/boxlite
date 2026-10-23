import { deleteApp, purgeExpired, restoreApp } from '../src/lifecycle.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { signConsoleSession, verifyConsoleSession } from '../src/console-auth.js';

// The test CP runs on https, so the console cookie carries the __Host- prefix.
const CONSOLE_COOKIE = '__Host-bxl_console';
import { ADMIN, TOML, harness, sha, upload, type Harness } from './helpers.js';

let h: Harness;
let cookie: string;

beforeEach(() => {
  h?.close();
  h = harness();
  cookie = `${CONSOLE_COOKIE}=${signConsoleSession('test-session-secret')}`;
});
after(() => h.close());

/** A console API call on the console origin with the signed-in cookie; writes carry the CSRF header like the console does. */
async function api<T = any>(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const method = init.method ?? 'GET';
  const csrf: Record<string, string> = method === 'GET' ? {} : { 'x-boxlite-console': '1' };
  const res = await h.request(`/console/api${path}`, { method, json: init.json, headers: { cookie, ...csrf, ...init.headers } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const DB_TOML = `${TOML}
[database]
migrations = "migrations/"

[variables]
LOG_LEVEL = "info"
`;
const INIT_SQL = 'CREATE TABLE deals (id serial PRIMARY KEY, title text);';

async function createViaConsole(name = 'crm'): Promise<{ key: string; prompt: string; app: any }> {
  const res = await api('/apps', { method: 'POST', json: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** Uploads and deploys `toml` with the App key, the way the CLI does, and waits for the result. */
async function deploy(key: string, toml: string, files: Record<string, string> = {}) {
  const all = { 'boxlite.toml': toml, 'package.json': '{"name":"crm"}', 'package-lock.json': '{}', 'server.js': 'console.log(1)', ...files };
  const snapshot = await upload(h, key, all);
  const migrations = Object.entries(files)
    .filter(([p]) => p.startsWith('migrations/'))
    .map(([p, s]) => ({ file: p.slice('migrations/'.length), sha256: sha(s), sql: s }));
  const res = await h.request('/v1/apps/crm/envs/main/deployments', {
    method: 'POST',
    key,
    json: { kind: 'deploy', snapshot_id: snapshot, manifest: parseManifest(toml, 'main').manifest, base_version: h.ctx.store.latestSpecVersion(mainEnv().id), migrations, message: 'first version' },
  });
  assert.equal(res.status, 202, await res.clone().text());
  await h.ctx.orchestrator.idle(mainEnv().id);
}

const mainEnv = () => h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;

// ---- auth ------------------------------------------------------------------

test('the console API needs the console cookie; the login page issues it for the admin token', async () => {
  assert.equal((await h.request('/console/api/apps')).status, 401);
  assert.equal((await h.request('/console/api/apps', { headers: { cookie: `${CONSOLE_COOKIE}=admin.9999999999.forged` } })).status, 401);
  // An App key or the admin token as a bearer is not a console session.
  assert.equal((await h.request('/console/api/apps', { key: ADMIN })).status, 401);

  const bad = await h.request('/console/login', { method: 'POST', body: new URLSearchParams({ token: 'nope' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  const ok = await h.request('/console/login', { method: 'POST', body: new URLSearchParams({ token: ADMIN, next: '/console/dashboard/apps' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/console/dashboard/apps');
  const set = ok.headers.get('set-cookie')!;
  assert.match(set, /__Host-bxl_console=admin\.\d+\./);
  assert.match(set, /Path=\/;/);
  assert.doesNotMatch(set, /Domain=/i);
  assert.match(set, /HttpOnly/);
  const value = /__Host-bxl_console=([^;]+)/.exec(set)![1]!;
  assert.equal(verifyConsoleSession('test-session-secret', value), 'admin');
  assert.equal(verifyConsoleSession('other-secret', value), null);

  const res = await h.request('/console/api/session', { headers: { cookie: `${CONSOLE_COOKIE}=${value}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as any).user, 'admin');

  // An open redirect through `next` is refused.
  const evil = await h.request('/console/login', { method: 'POST', body: new URLSearchParams({ token: ADMIN, next: '//evil.test/' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(evil.headers.get('location'), '/console/');
});

test('console pages redirect to login; cross-site writes are refused', async () => {
  const page = await h.request('/console/dashboard/apps');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/console/login?next=%2Fconsole%2Fdashboard%2Fapps');
  const cross = await api('/apps', { method: 'POST', json: { name: 'crm' }, headers: { origin: 'https://evil.test' } });
  assert.equal(cross.status, 403);
  // CSRF: without X-BoxLite-Console a write is refused even from the console's own origin.
  const noHeader = await h.request('/console/api/apps', { method: 'POST', json: { name: 'crm' }, headers: { cookie } });
  assert.equal(noHeader.status, 403);
  assert.match(((await noHeader.json()) as any).error.message, /x-boxlite-console: 1/);
  assert.equal((await api('/apps', { method: 'POST', json: { name: 'crm' }, headers: { 'x-boxlite-console': '0' } })).status, 403);
  assert.equal(h.ctx.store.appByName('crm'), undefined);
  assert.equal((await api('/apps')).status, 200, 'reads need no header');
  // The console is served only on its own origin; /console on the API origin is sent there.
  const onApi = await h.request('/console/api/apps', { headers: { cookie }, port: h.ctx.origins.apiPort });
  assert.equal(onApi.status, 302);
  assert.equal(onApi.headers.get('location'), 'https://8081-cp.test/console/api/apps');
});

test('"console" and "auth" are reserved app names for both the console and /v1', async () => {
  assert.equal((await api('/apps', { method: 'POST', json: { name: 'console' } })).status, 400);
  assert.equal((await api('/apps', { method: 'POST', json: { name: 'auth' } })).status, 400);
  const res = await h.request('/v1/apps', { method: 'POST', key: ADMIN, json: { name: 'console' } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error.message, /reserved/);
});

// ---- mapping ---------------------------------------------------------------

test('create returns the key and the filled-in prompt once; detail shows a draft with the key masked', async () => {
  const { key, prompt, app } = await createViaConsole();
  assert.match(key, /^bxl_app_[a-z2-7]{32}$/);
  assert.ok(prompt.includes(`BOXLITE_API_KEY=${key}`));
  assert.ok(prompt.includes('BOXLITE_API_URL=https://cp.test'));
  assert.ok(prompt.includes('App: crm'));
  assert.ok(!prompt.includes('{{'));
  assert.equal(app.url, 'https://10001-cp.test/');
  assert.equal(app.environment, 'main');
  assert.equal(app.status, 'draft');
  assert.equal(app.visibility, 'private');
  assert.equal(app.activeRelease, null);
  assert.deepEqual(app.releases, []);
  assert.equal(app.variables, null);
  assert.equal(app.metrics, null);
  assert.equal(app.key.last4, key.slice(-4));
  assert.ok(!app.handoffPrompt.includes(key), 'the stored prompt never carries the key');
  assert.ok(app.handoffPrompt.includes(key.slice(-4)));
  // The CP keeps only the hash.
  assert.equal(h.ctx.store.get<{ n: number }>("SELECT count(*) AS n FROM keys WHERE hash = ?", sha(key))!.n, 1);
  assert.equal(JSON.stringify(h.ctx.store.all('SELECT * FROM keys')).includes(key), false);

  const list = await api('/apps');
  assert.equal(list.body.length, 1);
  assert.deepEqual(
    { id: list.body[0].id, url: list.body[0].url, status: list.body[0].status, environments: list.body[0].environments, lastDeploy: list.body[0].lastDeploy },
    { id: 'crm', url: 'https://10001-cp.test/', status: 'draft', environments: 1, lastDeploy: null },
  );
  const activity = (await api('/apps/crm')).body.activity;
  assert.deepEqual(activity.map((a: any) => `${a.actor} ${a.action}`), ['console created the app']);
});

test('a deployed app maps to live with its deployment, services, runtime, database and variables', async () => {
  const { key } = await createViaConsole();
  h.supervisor.health = async () => ({ ok: true, deployment: 1, services: [{ name: 'web', state: 'running', health: 'healthy', port: 20001, pid: 42, restarts: 0, last_exit_code: null }] });
  await deploy(key, DB_TOML, { 'migrations/0001_init.sql': INIT_SQL });

  const { status, body: app } = await api('/apps/crm');
  assert.equal(status, 200);
  assert.equal(app.status, 'live');
  assert.equal(app.activeRelease, '#1');
  assert.deepEqual(app.runtime, { image: 'node', size: 'small', cpus: 1, memoryMib: 2048 });
  assert.equal(app.box.id, 'box1');
  assert.equal(app.box.state, 'running');
  assert.equal(app.releases.length, 1);
  const r = app.releases[0];
  assert.equal(r.id, '#1');
  assert.equal(r.summary, 'first version');
  assert.equal(r.status, 'live');
  assert.equal(r.current, true);
  assert.equal(r.by.startsWith('key …'), true);
  assert.equal(r.files, 5);
  assert.equal(r.hasSource, true);
  assert.equal(r.rollback.possible, false);
  assert.ok(r.steps.some((s: any) => s.name === 'migrate'));
  assert.deepEqual(app.services.map((s: any) => [s.name, s.state, s.health, s.port, s.exposed, s.healthPath]), [['web', 'running', 'healthy', 20001, true, '/healthz']]);
  assert.deepEqual(app.variables, { LOG_LEVEL: 'info' });
  assert.equal(app.database.host, 'ep-main.neon.test');
  assert.equal(app.database.user, 'neondb_owner');
  assert.ok(!JSON.stringify(app).includes(':pw@'), 'no database password anywhere in the detail');
  assert.ok(app.platformVariables.some((v: any) => v.name === 'DATABASE_URL' && !v.value.includes('pw')));
  assert.deepEqual(app.problems, []);

  const envs = await api('/apps/crm/environments');
  assert.deepEqual(envs.body.map((e: any) => [e.name, e.status, e.box, e.lastDeploy.releaseId]), [['main', 'live', 'box1', '#1']]);
});

test('a failed deployment is a problem with its step; the summary says what needs attention', async () => {
  const { key } = await createViaConsole();
  h.supervisor.failBuild = true;
  await deploy(key, TOML);
  const app = (await api('/apps/crm')).body;
  assert.equal(app.status, 'failed');
  assert.equal(app.releases[0].status, 'failed');
  assert.match(app.releases[0].error, /^build: npm ci exited with 1/);
  assert.equal(app.problems[0].summary, 'Deployment #1 failed at build');
  assert.match(app.problems[0].fixPrompt, /boxlite-app app deployment 1 --logs/);
  assert.match((await api('/apps')).body[0].attention, /#1 failed at build/);
});

test('saving a variable is one apply deployment, with the migrations re-sent so nothing re-runs', async () => {
  const { key } = await createViaConsole();
  await deploy(key, DB_TOML, { 'migrations/0001_init.sql': INIT_SQL });
  const res = await api('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name: 'FEATURE', value: 'on' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.releases[0].id, '#2');
  assert.equal(res.body.releases[0].summary, 'Set FEATURE');
  assert.equal(res.body.releases[0].by, 'console');
  await h.ctx.orchestrator.idle(mainEnv().id);

  const d = h.ctx.store.deployment(mainEnv().id, 2)!;
  assert.equal(d.kind, 'apply');
  assert.equal(d.status, 'live');
  assert.deepEqual(d.request.migrations?.map((m) => [m.file, m.sql]), [['0001_init.sql', INIT_SQL]]);
  const spec = h.ctx.store.spec(mainEnv().id)!;
  assert.deepEqual(spec.variables, { LOG_LEVEL: 'info', FEATURE: 'on' });
  assert.deepEqual(spec.database?.applied.map((a) => a.file), ['0001_init.sql']);
  assert.equal(h.appdb.applied.length, 1, 'the applied migration did not run again');
  assert.ok(d.changes.some((c) => c.path === 'variables.FEATURE'));
  assert.ok(h.supervisor.calls.includes('rollback 1'), 'the live release restarted with the new env');

  const app = (await api('/apps/crm')).body;
  assert.deepEqual(app.variables, { LOG_LEVEL: 'info', FEATURE: 'on' });
  assert.equal(app.activeRelease, '#2');
  assert.ok(!('pendingChanges' in app));

  // Platform names are refused; an unknown secret is refused.
  assert.equal((await api('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name: 'DATABASE_URL', value: 'x' } })).status, 400);
  assert.equal((await api('/apps/crm/actions', { method: 'POST', json: { type: 'referenceSecret', name: 'OPENAI', from: 'org/none' } })).status, 404);
});

test('variables cannot be edited before anything is configured', async () => {
  await createViaConsole();
  const res = await api('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name: 'A', value: 'b' } });
  assert.equal(res.status, 409);
});

test('rollback through activate creates a rollback deployment run by the orchestrator', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  await deploy(key, TOML.replace('npm ci', 'npm ci --silent'));
  const before = (await api('/apps/crm')).body;
  assert.equal(before.releases.find((r: any) => r.id === '#1').rollback.possible, true);
  const res = await api(`/apps/crm/releases/${encodeURIComponent('#1')}/activate`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await h.ctx.orchestrator.idle(mainEnv().id);
  const d = h.ctx.store.deployment(mainEnv().id, 3)!;
  assert.equal(d.kind, 'rollback');
  assert.equal(d.status, 'live');
  assert.equal(d.request.to, 1);
  assert.equal(d.by, 'console');
  const app = (await api('/apps/crm')).body;
  assert.equal(app.activeRelease, '#3');
  assert.equal(app.releases.find((r: any) => r.id === '#2').status, 'rolled_back');
  assert.equal(app.releases[0].summary, 'Roll back to #1');
});

test('the Auth tab maps end-user sign-in: methods, users, and user actions as actor console', async () => {
  const { key } = await createViaConsole();
  await deploy(key, `${TOML}\n[auth]\nproviders = ["github"]\nprotect = ["/app/*"]\n`);
  const auth = (await api('/apps/crm/auth')).body;
  assert.equal(auth.status.declared, true);
  assert.deepEqual(auth.status.providers, ['github']);
  assert.deepEqual(auth.status.protect, ['/app/*']);
  // The test control plane has no OAuth app configured.
  assert.equal(auth.status.enforced, false);
  assert.deepEqual(
    auth.status.methods.map((m: any) => [m.provider, m.status, m.declared]).sort(),
    [['github', 'not_configured', true], ['google', 'not_configured', false]],
  );
  assert.deepEqual(auth.users, []);
  assert.equal((await api('/apps/crm')).body.auth.declared, true);

  // A real user from the end-user module: a test session creates one.
  const { createTestSession } = await import('../src/enduser/management.js');
  const app = h.ctx.store.appByName('crm')!;
  const s = await createTestSession(h.ctx, app, mainEnv(), 'qa@example.com', 'test');
  const users = (await api('/apps/crm/auth')).body.users;
  assert.deepEqual(users.map((u: any) => [u.email, u.provider, u.blocked, u.sessions]), [['qa@example.com', 'test', false, 1]]);
  const blocked = await api(`/apps/crm/users/${s.user.id}/block`, { method: 'POST' });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.users[0].blocked, true);
  assert.equal(blocked.body.users[0].sessions, 0);
  const activity = (await api('/apps/crm')).body.activity;
  assert.ok(activity.some((a: any) => a.actor === 'console' && a.action === 'blocked a user'));
  const csv = await h.request('/console/api/apps/crm/users.csv', { headers: { cookie } });
  assert.match(await csv.text(), /qa@example\.com/);
  assert.equal((await api('/apps/crm/users/nobody/block', { method: 'POST' })).status, 404);
});

test('access level is set through the CP; public is accepted, users is not', async () => {
  await createViaConsole();
  const res = await api('/apps/crm/publish', { method: 'POST', json: { visibility: 'public' } });
  assert.equal(res.body.visibility, 'public');
  assert.equal(res.body.accessSource, 'online');
  assert.equal((await api('/apps/crm/publish', { method: 'POST', json: { visibility: 'users' } })).status, 400);
});

test('rotating the key revokes the old one and returns a new prompt', async () => {
  const { key } = await createViaConsole();
  const res = await api('/apps/crm/key/rotate', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.key, key);
  assert.ok(res.body.prompt.includes(res.body.key));
  assert.equal((await h.request('/v1/apps/crm', { key })).status, 401);
  assert.equal((await h.request('/v1/apps/crm', { key: res.body.key })).status, 200);
  assert.ok((await api('/apps/crm')).body.activity.some((a: any) => a.actor === 'console' && a.action === 'rotated the App key'));
});

test('open-ticket opens a private app on its own origin; requests there feed access logs and metrics', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  const res = await api('/apps/crm/open-ticket', { method: 'POST', json: { next: '/deals?x=1' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const url = new URL(res.body.url);
  assert.equal(url.origin, 'https://10001-cp.test');
  assert.equal(url.pathname, '/.boxlite/open');
  const port = h.appPort();
  const open = await h.request(url.pathname + url.search, { port });
  assert.equal(open.status, 302);
  assert.equal(open.headers.get('location'), '/deals?x=1');
  const appCookie = /__Host-bxl_access=[^;]+/.exec(open.headers.get('set-cookie')!)![0];
  // The cookie opens the private app through the real gate (the fake supervisor's tunnel is unreachable, so not 401 is the point).
  assert.notEqual((await h.request('/', { headers: { cookie: appCookie }, port })).status, 401);
  // Single use; and the ticket API is a write, so it needs the CSRF header.
  assert.equal((await h.request(url.pathname + url.search, { port })).status, 401);
  assert.equal((await h.request('/console/api/apps/crm/open-ticket', { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await api('/apps/crm/open-ticket', { method: 'POST', json: { next: '//evil.test' } })).status, 400);
  // The old state-changing GET hop no longer sets anything.
  assert.equal((await h.request('/console/open/crm', { headers: { cookie } })).headers.get('set-cookie'), null);

  // No cookie: the gate answers 401, and the request is still logged, without one-time values.
  assert.equal((await h.request('/hello?__key=nope&t=secret&keep=1', { port })).status, 401);
  const logs = (await api('/apps/crm/logs?since=1h')).body;
  const line = logs.find((l: any) => l.source === 'access' && l.line.includes('/hello'));
  assert.ok(line, JSON.stringify(logs));
  assert.match(line.line, /^GET \/hello\?keep=1 401 \d+ms$/);
  assert.ok(!line.line.includes('__key') && !line.line.includes('secret'));
  assert.equal(line.level, 'warn');
  const opened = logs.find((l: any) => l.source === 'access' && l.line.startsWith('GET /.boxlite/open'));
  assert.ok(opened && !opened.line.includes(url.searchParams.get('t')!), 'the ticket is never logged');
  assert.ok(logs.some((l: any) => l.source === 'system'));
  const app = (await api('/apps/crm')).body;
  assert.equal(app.metrics.requests.reduce((a: number, b: number) => a + b, 0), 4);
  assert.equal(app.metrics.requests.length, 24);
});

test('sleep stops the Box and is recorded; delete is soft, restorable, then purged with its Box', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  await api('/apps/crm'); // warms the Box status cache with "running"
  const probesBefore = h.supervisor.calls.filter((c) => c === 'health').length;
  const slept = await api('/apps/crm/sleep', { method: 'POST' });
  assert.equal(slept.status, 200);
  assert.ok(h.boxlite.calls.includes('stop box1'));
  // Observing a sleeping app must not wake it: no health probe after the stop.
  await api('/apps/crm');
  assert.equal(h.supervisor.calls.filter((c) => c === 'health').length, probesBefore, 'the console woke the Box it just put to sleep');
  assert.equal(slept.body.activity[0].action, 'put the Box to sleep');
  const del = await api('/apps/crm', { method: 'DELETE' });
  assert.equal(del.status, 204);
  // Soft delete: hidden everywhere, key revoked, resources kept until the purge.
  assert.equal(h.ctx.store.appByName('crm'), undefined);
  assert.equal((await api('/apps')).body.length, 0);
  assert.ok(!h.boxlite.calls.includes('delete box1'));
  const gone = await h.appRequest('/');
  assert.equal(gone.status, 410);
  assert.equal((await h.request('/crm/')).status, 301, 'the old prefix still points at the origin');
  const deleted = h.ctx.store.appByNameAnyState('crm')!;
  restoreApp(h.ctx, deleted, 'test');
  assert.ok(h.ctx.store.appByName('crm'));
  assert.equal((await h.app.request('/v1/apps/crm', { headers: { authorization: `Bearer ${key}` } })).status, 200);
  await deleteApp(h.ctx, h.ctx.store.appByName('crm')!, 'test');
  assert.deepEqual(await purgeExpired(h.ctx, new Date(Date.now() + 8 * 86_400_000)), ['crm']);
  assert.ok(h.boxlite.calls.includes('delete box1'));
  assert.equal(h.ctx.store.appByNameAnyState('crm'), undefined);
});

test('database routes map schema, rows with paging and SQL from the real db routes', async () => {
  const { key } = await createViaConsole();
  await deploy(key, DB_TOML, { 'migrations/0001_init.sql': INIT_SQL });
  h.appdb.query = async (_u, statements) => {
    h.appdb.queries.push({ statements, write: false });
    const q = statements.at(-1)!;
    if (q.includes('UNION ALL') || q.startsWith(`SELECT 'deals', count(*)`)) return { columns: ['?column?', 'count'], rows: [['deals', '3']], row_count: 1, truncated: false, elapsed_ms: 1 };
    if (q.includes("table_type = 'BASE TABLE'")) return { columns: ['table_name'], rows: [['deals']], row_count: 1, truncated: false, elapsed_ms: 1 };
    if (q.includes('information_schema.columns')) return { columns: ['column_name', 'data_type'], rows: [['id', 'integer'], ['title', 'text']], row_count: 2, truncated: false, elapsed_ms: 1 };
    if (q.startsWith('SELECT count(*)')) return { columns: ['count'], rows: [['3']], row_count: 1, truncated: false, elapsed_ms: 1 };
    if (q.includes('information_schema.tables')) return { columns: ['?column?'], rows: [[1]], row_count: 1, truncated: false, elapsed_ms: 1 };
    return { columns: ['id', 'title', 'at'], rows: [[1, 'a', new Date('2026-10-21T00:00:00Z')]], row_count: 1, truncated: false, elapsed_ms: 1 };
  };
  const db = (await api('/apps/crm/database')).body;
  assert.equal(db.host, 'ep-main.neon.test');
  assert.deepEqual(db.tables, [{ schema: 'public', name: 'deals', rows: 3 }]);
  assert.deepEqual(db.migrations.map((m: any) => [m.file, m.status]), [['0001_init.sql', 'applied']]);
  assert.deepEqual(db.backups, []);
  assert.ok(!JSON.stringify(db).includes('pw'));

  const rows = (await api("/apps/crm/database/rows/deals?search=o'k&limit=20&offset=20")).body;
  assert.equal(rows.total, 3);
  assert.deepEqual(rows.rows, [[1, 'a', '2026-10-21T00:00:00.000Z']]);
  assert.deepEqual(rows.types, ['integer', 'text', null]);
  const sent = h.appdb.queries.map((q) => q.statements.join(';')).find((s) => s.includes('LIMIT $1 OFFSET $2'))!;
  assert.match(sent, /WHERE "deals"::text ILIKE '%o''k%'/);

  assert.equal((await api('/apps/crm/sql', { method: 'POST', json: { query: 'ALTER TABLE deals ADD COLUMN x int', write: true } })).status, 403);
  const backup = await api('/apps/crm/actions', { method: 'POST', json: { type: 'createBackup' } });
  assert.equal(backup.status, 200);
  assert.equal((await api('/apps/crm/database')).body.backups.length, 1);
});

test('deployment detail is a timeline: timed steps, grouped changes, code file counts, classified failure', async () => {
  const { key } = await createViaConsole();
  await deploy(key, DB_TOML, { 'migrations/0001_init.sql': INIT_SQL });
  const first = (await api('/apps/crm/deployments/1')).body;
  assert.equal(first.status, 'live');
  assert.ok(first.timeline.length > 3 && first.timeline.every((s: any) => s.startedAt && s.status === 'done'), JSON.stringify(first.timeline));
  assert.ok(first.changeSet.infrastructure.includes('Added a database'), JSON.stringify(first.changeSet));
  assert.ok(first.changeSet.configuration.includes('New variable LOG_LEVEL'), JSON.stringify(first.changeSet));
  assert.deepEqual(first.changeSet.code, { added: 5, changed: 0, removed: 0, files: 5, comparedWith: null });
  assert.equal(first.failure, null);
  assert.equal(first.specVersion, 1);

  h.supervisor.failBuild = true;
  await deploy(key, DB_TOML, { 'migrations/0001_init.sql': INIT_SQL, 'server.js': 'console.log(2)' });
  const failed = (await api('/apps/crm/deployments/2')).body;
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.changeSet.code, { added: 0, changed: 1, removed: 0, files: 5, comparedWith: 1 });
  assert.equal(failed.failure.step, 'build');
  assert.equal(failed.failure.cause, 'build_command_failed');
  assert.match(failed.failure.fix, /npm ci/);
  assert.match(failed.failure.fixPrompt, /^Deployment #2 of the BoxLite app "crm" \(environment main\) failed at step "build"/);
  assert.match(failed.failure.fixPrompt, /boxlite-app app deployment 2 --logs/);
  const app = (await api('/apps/crm')).body;
  assert.equal(app.releases[0].cause, failed.failure.summary);
  assert.equal(app.problems[0].serving, '#1', 'the failure says the old release keeps serving');
  assert.equal((await api('/apps/crm/deployments/9')).status, 404);
});

test('activity names the console as actor and links a started deployment to it', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  await api('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name: 'A', value: '1' } });
  await h.ctx.orchestrator.idle(mainEnv().id);
  // The Activity tab reads it from the app detail (the separate /activity route had no caller).
  const activity = (await api('/apps/crm')).body.activity;
  const started = activity.filter((a: any) => a.action === 'started a deployment');
  assert.deepEqual(
    started.map((a: any) => [a.actorKind, a.link?.deployment, a.detail]),
    [
      ['console', 2, '#2 · Set A'],
      ['agent', 1, '#1 · first version'],
    ],
  );
  assert.ok(activity.some((a: any) => a.actor === 'console' && a.action === 'created the app' && !a.detail));
});

test('a deleted app is listed under Recently deleted, restorable, and its name stays taken', async () => {
  const { key } = await createViaConsole();
  assert.equal((await api('/apps/crm', { method: 'DELETE' })).status, 204);
  const deleted = (await api('/deleted-apps')).body;
  assert.deepEqual(deleted.map((d: any) => d.name), ['crm']);
  assert.ok(Date.parse(deleted[0].purgeAfter) - Date.parse(deleted[0].deletedAt) === 7 * 86_400_000);
  const again = await api('/apps', { method: 'POST', json: { name: 'crm' } });
  assert.equal(again.status, 409);
  assert.match((again.body as any).error.message, /deleted app that is kept until/);
  const restored = await api('/deleted-apps/crm/restore', { method: 'POST' });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.name, 'crm');
  assert.deepEqual((await api('/deleted-apps')).body, []);
  assert.equal((await h.request('/v1/apps/crm', { key })).status, 200, 'the App key works again');
  assert.equal((await api('/deleted-apps/nope/restore', { method: 'POST' })).status, 404);
});

test('schedules of the live release are listed with their next run and can be run from the console', async () => {
  const { key } = await createViaConsole();
  await deploy(key, `${TOML}\n[[schedule]]\nname = "tick"\ncron = "*/5 * * * *"\ntarget = "web:/jobs/tick"\n`);
  const app = (await api('/apps/crm')).body;
  assert.equal(app.schedules.length, 1);
  assert.equal(app.schedules[0].cron, '*/5 * * * *');
  assert.ok(Date.parse(app.schedules[0].nextRun) > Date.now());
  assert.equal(app.schedules[0].lastRun, null);
  const run = await api('/apps/crm/schedules/tick/run', { method: 'POST' });
  assert.ok([200, 502, 503].includes(run.status), JSON.stringify(run.body));
  assert.equal((await api('/apps/crm/schedules/nope/run', { method: 'POST' })).status, 404);
});

// ---- static files ----------------------------------------------------------

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  delete h.ctx.config.consoleDir;
});

test('the built console is served under /console/ with an SPA fallback', async () => {
  dir = mkdtempSync(join(tmpdir(), 'console-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  h.ctx.config.consoleDir = dir;
  const get = (p: string) => h.request(p, { headers: { cookie } });
  assert.equal((await h.request('/console')).status, 308);
  const index = await get('/console/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /id="root"/);
  const route = await get('/console/dashboard/apps/crm');
  assert.match(route.headers.get('content-type')!, /text\/html/);
  const asset = await get('/console/assets/app-abc.js');
  assert.match(asset.headers.get('content-type')!, /javascript/);
  assert.match(asset.headers.get('cache-control')!, /immutable/);
  assert.equal((await get('/console/assets/missing.js')).status, 404);
  assert.equal((await get('/console/..%2f..%2fetc%2fpasswd')).status, 404);
});

test("a troubled service's errors are the serving deployment's, not ones from before it", async () => {
  const { key } = await createViaConsole();
  h.supervisor.health = async () => ({ ok: true, deployment: 1, services: [{ name: 'web', state: 'restarting', health: 'none', port: 20001, pid: null, restarts: 3, last_exit_code: 1 }] });
  await deploy(key, TOML);
  const env = mainEnv();
  h.ctx.store.appendLogs(env.id, [
    { ts: '2020-01-01T00:00:00.000Z', source: 'web', level: 'error', line: 'Error: from before this deployment', deployment: null },
    { ts: new Date(Date.now() + 1000).toISOString(), source: 'web', level: 'error', line: 'Error: SLACK_TOKEN is not set', deployment: 1 },
  ]);
  const web = (await api('/apps/crm')).body.services.find((s: any) => s.name === 'web');
  assert.equal(web.recentErrors.length, 1, web.recentErrors.join(' | '));
  assert.match(web.recentErrors[0], /SLACK_TOKEN is not set$/);
  const problem = (await api('/apps/crm')).body.problems.find((p: any) => /web/.test(p.summary));
  assert.equal(problem?.missingVariable, 'SLACK_TOKEN');
});

test('Sleep on a Box that already stopped by itself succeeds instead of failing', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  // BoxLite auto-stopped it; the CP has not looked since.
  h.boxlite.boxes.get('box1')!.status = 'stopped';
  const slept = await api('/apps/crm/sleep', { method: 'POST' });
  assert.equal(slept.status, 200, JSON.stringify(slept.body));
  assert.equal(slept.body.status, 'sleeping');
});

test('a sign-in method can use the App own OAuth app; its secret never comes back', async () => {
  const { key } = await createViaConsole();
  await deploy(key, TOML);
  const before = (await api('/apps/crm/auth')).body.status.methods;
  assert.equal(before.find((m: any) => m.provider === 'google').status, 'not_configured', 'BoxLite has no Google app here');

  const saved = await api('/apps/crm/auth/methods/google', { method: 'PUT', json: { keys: 'own', clientId: 'my-google-id', clientSecret: 'my-google-secret' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const google = saved.body.status.methods.find((m: any) => m.provider === 'google');
  assert.deepEqual([google.status, google.keys, google.clientId], ['ready', 'own', 'my-google-id']);
  assert.ok(!JSON.stringify(saved.body).includes('my-google-secret'), 'the secret is never returned');
  const { oauthClientFor } = await import('../src/enduser/config.js');
  const app = h.ctx.store.appByName('crm')!;
  assert.deepEqual(oauthClientFor(h.ctx, app, 'google'), { clientId: 'my-google-id', clientSecret: 'my-google-secret', own: true });

  // A new client id without a secret keeps the saved secret.
  await api('/apps/crm/auth/methods/google', { method: 'PUT', json: { keys: 'own', clientId: 'my-google-id-2' } });
  assert.equal(oauthClientFor(h.ctx, app, 'google')!.clientSecret, 'my-google-secret');
  // Back to BoxLite's keys.
  const back = await api('/apps/crm/auth/methods/google', { method: 'PUT', json: { keys: 'shared' } });
  assert.equal(back.body.status.methods.find((m: any) => m.provider === 'google').status, 'not_configured');
  // Own keys without ever giving a secret are refused.
  assert.equal((await api('/apps/crm/auth/methods/github', { method: 'PUT', json: { keys: 'own', clientId: 'gh-id' } })).status, 400);
});

test('the console can ask for a new screenshot of what is live, and only of something live', async () => {
  const { key } = await createViaConsole();
  assert.equal((await api('/apps/crm/preview', { method: 'POST' })).status, 409, 'nothing live yet');
  await deploy(key, TOML);
  assert.equal((await api('/apps/crm/preview', { method: 'POST' })).status, 202);
});

test('a new App key from the console works next to the existing one; rotating retires both', async () => {
  const { key } = await createViaConsole();
  const issued = await api('/apps/crm/key/issue', { method: 'POST' });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.ok(issued.body.prompt.includes(issued.body.key), 'the prompt carries the new key');
  const whoami = (k: string) => h.request('/v1/apps/crm/whoami', { key: k });
  assert.equal((await whoami(key)).status, 200, 'the first key keeps working');
  assert.equal((await whoami(issued.body.key)).status, 200, 'the new key works');
  const rotated = await api('/apps/crm/key/rotate', { method: 'POST' });
  assert.equal((await whoami(key)).status, 401);
  assert.equal((await whoami(issued.body.key)).status, 401);
  assert.equal((await whoami(rotated.body.key)).status, 200);
});
