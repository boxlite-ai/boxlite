import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import { parseManifest, type Manifest } from '@microcloud/shared';
import { signConsoleSession } from '../src/console-auth.js';
import { Store } from '../src/db.js';
import { UpstreamError } from '../src/errors.js';
import { HttpNeonClient } from '../src/neon.js';
import { ADMIN, TOML, createApp, harness, upload, type Harness } from './helpers.js';

// Behaviour fixes from docs/code-health.md (2026-10-22), one test each.

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

const env = () => h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
const FILES = { 'package.json': '{"name":"crm"}', 'package-lock.json': '{}', 'server.js': 'console.log(1)' };
const manifestOf = (toml: string): Manifest => {
  const out = parseManifest(toml, 'main');
  assert.deepEqual(out.errors, []);
  return out.manifest!;
};

async function deploy(toml = TOML): Promise<Record<string, any>> {
  const snapshot = await upload(h, key, { ...FILES, 'boxlite.toml': toml });
  const res = await h.request('/v1/apps/crm/envs/main/deployments', {
    method: 'POST',
    key,
    json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifestOf(toml), base_version: h.ctx.store.effectiveSpecVersion(env().id), migrations: [] },
  });
  assert.equal(res.status, 202, await res.clone().text());
  const d = (await res.json()) as { number: number };
  await h.ctx.orchestrator.idle(env().id);
  return (await (await h.request(`/v1/apps/crm/envs/main/deployments/${d.number}`, { key })).json()) as Record<string, any>;
}

async function apply(manifest: unknown): Promise<Record<string, any>> {
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'apply', manifest, base_version: h.ctx.store.effectiveSpecVersion(env().id), migrations: [] } });
  assert.equal(res.status, 202, await res.clone().text());
  const d = (await res.json()) as { number: number };
  await h.ctx.orchestrator.idle(env().id);
  return (await (await h.request(`/v1/apps/crm/envs/main/deployments/${d.number}`, { key })).json()) as Record<string, any>;
}

const consoleCookie = () => `__Host-bxl_console=${signConsoleSession('test-session-secret')}`;
async function consoleApi(path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const method = init.method ?? 'GET';
  const res = await h.request(`/console/api${path}`, { method, json: init.json, headers: { cookie: consoleCookie(), ...(method === 'GET' ? {} : { 'x-boxlite-console': '1' }) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ---- #4: app clone after an apply ---------------------------------------------------------

test('an apply records the snapshot of the release it restarts, so its source downloads like a deploy', async () => {
  const first = await deploy();
  assert.equal(first.status, 'live', JSON.stringify(first.error));
  const applied = await apply({ ...manifestOf(TOML), variables: { LOG_LEVEL: 'debug' } });
  assert.equal(applied.status, 'live', JSON.stringify(applied.error));
  assert.equal(applied.snapshot_id, first.snapshot_id, 'the apply runs the deploy\'s code');
  const src = await h.request(`/v1/apps/crm/envs/main/deployments/${applied.number}/source`, { key });
  assert.equal(src.status, 200, await src.clone().text());
  assert.equal(src.headers.get('content-type'), 'application/gzip');
  assert.ok((await src.arrayBuffer()).byteLength > 0);
  // The console still says an apply changed no code.
  const detail = await consoleApi(`/apps/crm/deployments/${applied.number}`);
  assert.equal(detail.body.changeSet.code, null);
});

test('an apply before anything is live has no code, and its source is a clear 404', async () => {
  const applied = await apply(manifestOf(TOML));
  assert.equal(applied.snapshot_id, null);
  const src = await h.request(`/v1/apps/crm/envs/main/deployments/${applied.number}/source`, { key });
  assert.equal(src.status, 404);
});

test('migration 7: older applies get the snapshot of their release; neon_host is gone; access rows follow their env', () => {
  const path = join(h.dir, 'v6.sqlite');
  const s = new Store(path);
  s.run("INSERT INTO apps (id, name, created_at) VALUES ('app_1', 'old', 'now')");
  s.run("INSERT INTO envs (id, app_id, name, created_at, forward_secret) VALUES ('env_1', 'app_1', 'main', 'now', 'fwd')");
  const dep = (n: number, kind: string, snapshot: string | null, release: number | null) =>
    s.run("INSERT INTO deployments (env_id, number, kind, status, by, created_at, snapshot_id, request, release) VALUES ('env_1', ?, ?, 'superseded', 'k', 'now', ?, '{}', ?)", n, kind, snapshot, release);
  dep(1, 'deploy', 'snap_one', 1);
  dep(2, 'apply', null, 1);
  dep(3, 'apply', null, null);
  s.close();
  // Back to the schema before migration 7, with a request-log row of an env that no longer exists.
  const raw = new DatabaseSync(path);
  raw.exec(`DROP TABLE console_access;
    CREATE TABLE console_access (id INTEGER PRIMARY KEY AUTOINCREMENT, env_id TEXT NOT NULL, ts TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, ms INTEGER NOT NULL);
    INSERT INTO console_access (env_id, ts, method, path, status, ms) VALUES ('env_1', 'now', 'GET', '/', 200, 1), ('env_gone', 'now', 'GET', '/', 200, 1);
    ALTER TABLE envs RENAME COLUMN forward_secret TO gateway_secret; ALTER TABLE apps ADD COLUMN neon_host TEXT;
    UPDATE deployments SET snapshot_id = NULL WHERE kind = 'apply'; PRAGMA user_version = 6;`);
  raw.close();
  const m = new Store(path);
  try {
    assert.deepEqual(
      m.all<{ number: number; snapshot_id: string | null }>("SELECT number, snapshot_id FROM deployments WHERE env_id = 'env_1' ORDER BY number").map((r) => ({ ...r })),
      [
        { number: 1, snapshot_id: 'snap_one' },
        { number: 2, snapshot_id: 'snap_one' },
        { number: 3, snapshot_id: null },
      ],
    );
    assert.equal(m.envById('env_1')!.forward_secret, 'fwd');
    assert.ok(!m.all<{ name: string }>('PRAGMA table_info(apps)').some((c) => c.name === 'neon_host'));
    assert.deepEqual(m.all<{ env_id: string }>('SELECT env_id FROM console_access').map((r) => ({ ...r })), [{ env_id: 'env_1' }]);
    m.run("DELETE FROM envs WHERE id = 'env_1'");
    assert.deepEqual(m.all('SELECT * FROM console_access'), [], 'deleting the env removes its request log');
  } finally {
    m.close();
  }
});

// ---- #7: object manifests go through the shared rules ----------------------------------------

async function planErrors(manifest: unknown): Promise<string[]> {
  const res = await h.request('/v1/apps/crm/envs/main/plan', { method: 'POST', key, json: { manifest, base_version: 0 } });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { errors: { rule: string }[] }).errors.map((e) => e.rule);
}

test('a Manifest object is checked by the same rules as boxlite.toml text', async () => {
  const good = manifestOf(TOML);
  assert.deepEqual(await planErrors(good), []);
  assert.deepEqual(await planErrors(TOML), []);
  // What `check` rejects in TOML, the object form is rejected for too.
  for (const [toml, object] of [
    [`${TOML}\n[variables]\nBOXLITE_APP_URL = "https://elsewhere"\n`, { ...good, variables: { BOXLITE_APP_URL: 'https://elsewhere' } }],
    [`${TOML}\n[secrets]\nDATABASE_URL = "org/db"\n`, { ...good, secrets: { DATABASE_URL: 'org/db' } }],
    [TOML.replace('port = 3000', 'port = 0'), { ...good, services: [{ ...good.services[0]!, port: 0 }] }],
    [`${TOML}\n[[schedule]]\nname = "x"\ncron = "nope"\ntarget = "web:/x"\n`, { ...good, schedules: [{ name: 'x', cron: 'nope', target: 'web:/x' }] }],
  ] as const) {
    const fromToml = await planErrors(toml);
    assert.ok(fromToml.length > 0, toml);
    assert.deepEqual(await planErrors(object), fromToml, `object vs TOML for:\n${toml}`);
  }
  // Rules only the object form could break before: lower-case names, fields no boxlite.toml has.
  assert.deepEqual(await planErrors({ ...good, variables: { foo: 'x' } }), ['invalid_variable']);
  assert.deepEqual(await planErrors({ ...good, extra: true }), ['unknown_field']);
  assert.deepEqual(await planErrors({ ...good, environment: 'staging' }), ['env_mismatch']);
});

test('the console refuses variable names the shared rules refuse, with their message', async () => {
  await deploy();
  for (const [name, message] of [
    ['foo', /variable "foo" must match/],
    ['DATABASE_URL', /DATABASE_URL is set by BoxLite/],
    ['BOXLITE_ENV', /BOXLITE_ENV is set by BoxLite/],
  ] as const) {
    const res = await consoleApi('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name, value: '1' } });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'invalid_request');
    assert.match(res.body.error.message, message);
  }
  const imported = await consoleApi('/apps/crm/actions', { method: 'POST', json: { type: 'importVariables', values: { OK: '1', PORT: '80' } } });
  assert.equal(imported.status, 400);
  assert.match(imported.body.error.message, /PORT is set by BoxLite/);
  assert.equal(h.ctx.store.deployments(env().id).length, 1, 'nothing was applied');
});

// ---- #8: console variable edits start from the effective spec ------------------------------

test('a console variable edit after a failed deploy builds on what runs, not on the failed spec', async () => {
  const good = await deploy(`${TOML}\n[variables]\nA = "1"\n`);
  assert.equal(good.status, 'live');
  h.supervisor.failBuild = true;
  const broken = await deploy(`${TOML}\n[variables]\nA = "broken"\nB = "from the failed deploy"\n`);
  assert.equal(broken.status, 'failed');
  assert.equal(h.ctx.store.latestSpecVersion(env().id), 2, 'the failed deploy wrote spec v2');
  h.supervisor.failBuild = false;

  const res = await consoleApi('/apps/crm/actions', { method: 'POST', json: { type: 'setVariable', name: 'C', value: '3' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await h.ctx.orchestrator.idle(env().id);
  const edit = h.ctx.store.deployments(env().id, 1)[0]!;
  assert.equal(edit.kind, 'apply');
  assert.equal(edit.status, 'live', JSON.stringify(edit.error));
  assert.equal(edit.base_version, 1, 'planned against the effective spec');
  assert.deepEqual(edit.request.manifest?.variables, { A: '1', C: '3' });
});

// ---- #9: log levels survive to the console ----------------------------------------------------

test('warn lines stay warnings in the console and in log search', async () => {
  const ts = new Date().toISOString();
  h.ctx.store.appendLogs(
    env().id,
    ['info', 'warn', 'warning', 'error', 'FATAL'].map((level, i) => ({ ts, source: 'web', level, line: `line ${i}`, deployment: null })),
  );
  const logs = await consoleApi('/apps/crm/logs');
  assert.equal(logs.status, 200);
  const byLine = Object.fromEntries((logs.body as { line: string; level: string }[]).map((l) => [l.line, l.level]));
  assert.deepEqual(byLine, { 'line 0': 'info', 'line 1': 'warn', 'line 2': 'warn', 'line 3': 'error', 'line 4': 'error' });
  const warn = (await (await h.request('/v1/apps/crm/envs/main/logs/search?level=warn', { key })).json()) as { line: string }[];
  assert.deepEqual(warn.map((l) => l.line), ['line 1', 'line 2', 'line 3', 'line 4']);
  const errors = (await (await h.request('/v1/apps/crm/envs/main/logs/search?level=error', { key })).json()) as { line: string }[];
  assert.deepEqual(errors.map((l) => l.line), ['line 3', 'line 4']);
});

// ---- #10: unknown errors ----------------------------------------------------------------------

async function withConsoleErrors<T>(fn: () => Promise<T>): Promise<{ out: T; logged: string }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' '));
  try {
    return { out: await fn(), logged: logged.join('\n') };
  } finally {
    console.error = orig;
  }
}

test('an unknown error is a stable `internal` with an id; the details stay in the server log under it', async () => {
  h.ctx.store.envs = () => {
    throw new Error('SQLITE_CONSTRAINT: secret table detail');
  };
  const { out: res, logged } = await withConsoleErrors(() => h.request('/v1/apps/crm', { key }));
  assert.equal(res.status, 500);
  const { error } = (await res.json()) as { error: Record<string, string> };
  assert.equal(error.code, 'internal');
  assert.doesNotMatch(JSON.stringify(error), /SQLITE|secret table detail/);
  assert.match(error.request_id!, /^req_[0-9a-f]{16}$/);
  assert.equal(res.headers.get('x-request-id'), error.request_id);
  assert.match(error.next!, new RegExp(`report error id ${error.request_id}`));
  assert.match(logged, new RegExp(`${error.request_id}[\\s\\S]*secret table detail[\\s\\S]*at `), 'stack logged under the id');
});

test('an upstream refusal is the platform being unavailable, not the caller lacking scope; upstream text is not echoed', async () => {
  h.ctx.store.envs = () => {
    throw new UpstreamError('neon', 403, 'GET https://console.neon.tech/api/v2/projects/p → 403 {"key":"sk_live"}', '{"key":"sk_live"}');
  };
  const { out: res, logged } = await withConsoleErrors(() => h.request('/v1/apps/crm', { key }));
  assert.equal(res.status, 503);
  const { error } = (await res.json()) as { error: Record<string, string> };
  assert.equal(error.code, 'unavailable');
  assert.doesNotMatch(JSON.stringify(error), /neon\.tech|sk_live/);
  assert.match(error.next!, /report error id req_/);
  assert.match(logged, /sk_live/, 'the details are in the server log');
});

test('every error body carries a next, also where the throw gave none', async () => {
  const res = await h.request('/v1/apps/crm/envs/main/deployments/abc', { key });
  assert.equal(res.status, 400);
  const { error } = (await res.json()) as { error: Record<string, string> };
  assert.equal(error.code, 'invalid_request');
  assert.ok(error.next && error.next.length > 10, JSON.stringify(error));
});

// ---- wake failures ----------------------------------------------------------------------------

test('a Box that cannot be woken gets an error page and a system log line, not "Starting…" forever', async () => {
  const box = await h.boxlite.createBox({ name: 'app-crm-main' } as never);
  await h.boxlite.stopBox(box.id);
  h.ctx.store.updateEnv(env().id, { box_id: box.id, box_url: 'http://127.0.0.1:9', live_deployment: 1, access_override: 'public' });
  h.boxlite.startBox = async () => {
    throw new UpstreamError('boxlite', 403, 'POST /boxes/x/start → 403 quota exceeded');
  };
  const { out: first } = await withConsoleErrors(async () => {
    const r = await h.appRequest('/');
    await h.ctx.resources.wake(box.id);
    return r;
  });
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('x-boxlite-starting'), '1');
  const second = await h.appRequest('/', { headers: { accept: 'text/html' } });
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('x-boxlite-starting'), null);
  assert.match(await second.text(), /could not be started just now/);
  // A program gets the same answer as JSON, with what to do.
  const api = (await (await h.appRequest('/api')).json()) as { error: { code: string; next: string } };
  assert.equal(api.error.code, 'unavailable');
  assert.match(api.error.next, /boxlite-app app logs/);
  const system = h.ctx.store.logs(env().id, { source: 'system' });
  assert.ok(system.some((l) => l.level === 'error' && /could not start Box .*quota exceeded/.test(l.line)), JSON.stringify(system));
});

test('a Box BoxLite no longer has gets a "not running" page', async () => {
  h.ctx.store.updateEnv(env().id, { box_id: 'gone', box_url: 'http://127.0.0.1:9', live_deployment: 1, access_override: 'public' });
  const res = await h.appRequest('/', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-boxlite-starting'), null);
  assert.match(await res.text(), /crm is not available right now/);
});

// ---- reserved names -------------------------------------------------------------------------

test('"console" and "auth" are reserved by platform.ts itself', async () => {
  const { RESERVED_NAMES, nameProblem } = await import('../src/platform.js');
  assert.ok(RESERVED_NAMES.has('console') && RESERVED_NAMES.has('auth'));
  assert.equal(nameProblem('console'), 'is reserved by the control plane');
  const res = await h.request('/v1/apps', { method: 'POST', key: ADMIN, json: { name: 'console' } });
  assert.equal(res.status, 400);
});

// ---- Neon: bounded retries, no duplicate creates ----------------------------------------------

test('Neon: a create whose answer was lost is not repeated but found by name; reads are retried', async () => {
  const calls: string[] = [];
  let reads = 0;
  const server: Server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/projects/p/branches') return void res.writeHead(502).end('{"message":"bad gateway"}');
    if (req.method === 'GET' && req.url === '/projects/p/branches') {
      if (reads++ === 0) return void res.writeHead(503).end('{"message":"try later"}');
      return void res.end(JSON.stringify({ branches: [{ id: 'br-main', name: 'main' }, { id: 'br-dev', name: 'dev' }] }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const neon = new HttpNeonClient('k', 'org', 'r', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(await neon.createBranch('p', 'dev', 'br-main', 'schema-only'), { branchId: 'br-dev', logicalSizeBytes: null });
    assert.deepEqual(calls, ['POST /projects/p/branches', 'GET /projects/p/branches', 'GET /projects/p/branches'], 'the POST once, the read retried after 503');
  } finally {
    server.close();
  }
});
