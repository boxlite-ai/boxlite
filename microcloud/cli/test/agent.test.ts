import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AgentContext } from '@microcloud/shared';
import { clearResolvedApps } from '../src/context.js';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API, BASE_TOML, cleanup, cli, JSON_HEADERS, KEY, linkJson, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));
beforeEach(() => clearResolvedApps());

const NOW = new Date().toISOString();
const WHOAMI = {
  app: 'crm',
  actor: `key:…${KEY.slice(-4)}`,
  key: { last4: KEY.slice(-4), created_at: '2026-10-20T10:00:00.000Z' },
  scope: 'app:crm',
  environments: [{ name: 'main', status: 'live', url: 'https://cp.test/crm' }],
  control_plane: 'https://cp.test',
  cli: { latest_version: '0.9.0', download_url: 'https://cp.test/cli/boxlite-app.tgz' },
};

function context(over: Partial<AgentContext> = {}): AgentContext {
  return {
    app: 'crm',
    env: 'main',
    control_plane: 'https://cp.test',
    generated_at: NOW,
    status: 'live',
    urls: { app: 'https://cp.test/crm', health: 'https://cp.test/crm/healthz', login: null },
    access: { level: 'private', source: 'manifest' },
    environments: [{ name: 'main', status: 'live', url: 'https://cp.test/crm' }],
    live: { deployment: 2, spec_version: 2, live_at: NOW },
    box: { id: 'b1', state: 'running' },
    runtime: { image: 'node', size: 'small', build: ['npm ci'] },
    services: [{ name: 'web', exposed: true, command: 'node server.js', static: null, health_path: '/healthz', state: 'running', health: 'healthy', restarts: 0, last_exit_code: null }],
    schedules: [],
    database: { status: 'ready', branch: 'br-main', tables: [{ name: 'deals', columns: [{ name: 'id', type: 'integer', nullable: false, default: null }] }], migrations: [{ file: '0001_init.sql', status: 'applied', deployment: 2, applied_at: NOW }] },
    volumes: [{ name: 'uploads', mount: '/data/uploads', mode: 'rw' }],
    auth: { enabled: false, providers: [], protect: [], login_url: '', users: 0 },
    variables: [{ name: 'LOG_LEVEL', value: 'info', secret: false, source: 'boxlite.toml', resolved: true }, { name: 'OPENAI_API_KEY', value: null, secret: true, source: 'secret org/openai', resolved: true }],
    deployments: [{ number: 2, kind: 'deploy', status: 'live', message: 'deals', created_at: NOW, finished_at: NOW, spec_version: 2, error: null }],
    recent_errors: [],
    next_actions: [],
    cli: { latest_version: '0.9.0' },
    ...over,
  };
}

test('whoami: app, key scope, env, control plane, and a newer CLI', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/whoami', method: 'GET' }).reply(200, WHOAMI, { headers: JSON_HEADERS }).times(2);
  const human = await cli(['whoami'], { cwd: dir, dispatcher: agent });
  assert.equal(human.code, 0, human.stderr);
  assert.deepEqual(human.lines, [
    `App crm · environment main · key …${KEY.slice(-4)} (scope: this App only)`,
    'Control plane https://cp.test (via http://cp.test)',
    'Environments main live',
    'CLI 0.3.13 (latest 0.9.0)',
    'next: update the CLI: `npm install -g http://cp.test/cli/boxlite-app.tgz`',
  ]);
  const json = JSON.parse((await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent })).stdout);
  assert.deepEqual(json.cli, { version: '0.3.13', latest_version: '0.9.0', update_available: true, update_command: 'npm install -g http://cp.test/cli/boxlite-app.tgz' });
  assert.deepEqual(json.linked, { link_file: true, app: 'crm', matches_key: true });
});

test('whoami falls back to /v1/apps/me on a control plane without /whoami, and flags a foreign link.json', async () => {
  const dir = await project(root, { '.boxlite/link.json': JSON.stringify({ app: 'other', env: 'main', base_version: 0, api_url: 'http://cp.test' }) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/other/whoami', method: 'GET' }).reply(404, { error: { code: 'not_found', message: 'no route' } }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/me', method: 'GET' }).reply(200, { name: 'crm', envs: [] }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/cli/version', method: 'GET' }).reply(404, '');
  const res = await cli(['whoami'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.lines.at(-2), 'warning: .boxlite/link.json is linked to "other", but this key belongs to "crm"');
  assert.match(res.lines.at(-1) ?? '', /^next: use the key of other, or relink/);
});

test('docs lists topics, prints one offline, follows aliases, and filters the reference', async () => {
  const dir = await project(root, {});
  const list = JSON.parse((await cli(['docs', '--json'], { cwd: dir, env: {} })).stdout);
  assert.ok(list.topics.some((t: { topic: string }) => t.topic === 'runtime'));
  const runtime = await cli(['docs', 'runtime'], { cwd: dir, env: {} });
  assert.equal(runtime.code, 0);
  assert.match(runtime.lines[0] ?? '', /^## 3\. Runtime rules/);
  const alias = JSON.parse((await cli(['docs', 'setup', '--json'], { cwd: dir, env: {} })).stdout);
  assert.equal(alias.topic, 'install');
  const ref = await cli(['docs', 'reference', 'app', 'logs'], { cwd: dir, env: {} });
  assert.match(ref.stdout, /^### `boxlite-app app logs`/);
  assert.match(ref.stdout, /--grep <regex>/);
  const unknown = await cli(['docs', 'nope', '--json'], { cwd: dir, env: {} });
  assert.equal(unknown.code, 4);
  assert.match(JSON.parse(unknown.stderr).error.next, /lists the topics: install, /);
});

test('app context renders the environment as markdown, and --json returns the AgentContext', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const c = context({
    next_actions: [{ id: 'pending_migrations', severity: 'warn', title: '1 migration(s) not applied: 0002_x.sql', fix: '`boxlite-app apply --yes`' }],
    recent_errors: [{ ts: NOW, source: 'web', line: 'TypeError: boom', deployment: 2 }],
  });
  pool.intercept({ path: '/v1/apps/crm/envs/main/context', method: 'GET' }).reply(200, c, { headers: JSON_HEADERS }).times(2);
  const md = await cli(['app', 'context'], { cwd: dir, dispatcher: agent });
  assert.equal(md.code, 0, md.stderr);
  for (const part of [
    '# crm · main',
    '- Status: **live** (live: #2, spec v2)',
    '- **warn** 1 migration(s) not applied: 0002_x.sql',
    '  - fix: `boxlite-app apply --yes`',
    '| web | yes | node server.js | /healthz | running | healthy | 0 | — |',
    '### deals',
    '| id | integer | no | — |',
    '- uploads at `/data/uploads` (rw); list it with `boxlite-app app volume ls uploads`',
    '| OPENAI_API_KEY | (secret, set) | secret org/openai |',
    `${NOW} [web] TypeError: boom`,
  ]) {
    assert.ok(md.stdout.includes(part), `missing: ${part}`);
  }
  const json = await cli(['app', 'context', '--json'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(JSON.parse(json.stdout), c);
});

test('doctor runs local and online checks and ranks the problems with fixes', async () => {
  const dir = await project(root, {
    'boxlite.toml': `${BASE_TOML}[database]\n`,
    'package.json': '{}',
    'migrations/0001_init.sql': 'create table deals (id int);',
    'migrations/0002_more.sql': 'alter table deals add column x int;',
    '.boxlite/link.json': linkJson(2),
  });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/whoami', method: 'GET' }).reply(200, WHOAMI, { headers: JSON_HEADERS }).times(2);
  const failed = context({
    deployments: [
      { number: 3, kind: 'deploy', status: 'failed', message: null, created_at: NOW, finished_at: NOW, spec_version: null, error: { step: 'start', message: 'service web failed its health check within 1m0s', log_tail: ['[system] health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (1 attempt(s), last: HTTP 404)'] } },
      ...context().deployments,
    ],
  });
  pool.intercept({ path: '/v1/apps/crm/envs/main/context', method: 'GET' }).reply(200, failed, { headers: JSON_HEADERS }).times(2);
  const sha = (await import('node:crypto')).createHash('sha256').update('create table deals (id int);').digest('hex');
  pool.intercept({ path: '/v1/apps/crm/envs/main/db/applied', method: 'GET' }).reply(200, [{ file: '0001_init.sql', sha256: sha, deployment: 2, applied_at: NOW }], { headers: JSON_HEADERS }).times(2);
  pool.intercept({ path: '/v1/apps/crm/envs/main/probe', method: 'GET' }).reply(200, { url: 'https://cp.test/crm/healthz', path: '/healthz', status: 200, ok: true, ms: 12, starting: false, reason: 'ok', content_type: 'text/plain', body_head: 'ok' }, { headers: JSON_HEADERS }).times(2);

  const json = await cli(['doctor', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(json.code, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.problems.map((p: { id: string; severity: string }) => [p.id, p.severity]), [
    ['deploy_failed', 'error'],
    ['lockfile', 'warn'],
    ['cli_version', 'warn'],
    ['pending_migrations', 'warn'],
  ]);
  assert.match(report.problems[0].fix, /GET \/healthz/);
  const checks = Object.fromEntries(report.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
  assert.equal(checks.key, 'ok');
  assert.equal(checks.manifest, 'ok');
  assert.equal(checks.reachable, 'ok');
  assert.equal(checks.database, 'ok');

  const human = await cli(['doctor'], { cwd: dir, dispatcher: agent });
  assert.equal(human.lines[0], 'Doctor · crm/main · CLI 0.3.13');
  assert.match(human.lines[1] ?? '', /^x error deployment #3 failed at start: web answers 404 on its health path \/healthz/);
  assert.match(human.lines.at(-1) ?? '', /^next: add a route GET \/healthz/);
});

test('doctor with a rejected key reports it first and skips the online checks', async () => {
  const dir = await project(root, { 'boxlite.toml': BASE_TOML, 'package-lock.json': '{}', 'package.json': '{}' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me/whoami', method: 'GET' }).reply(401, { error: { code: 'unauthenticated', message: 'App key not recognised' } }, { headers: JSON_HEADERS });
  const res = await cli(['doctor', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.problems.map((p: { id: string }) => p.id), ['key']);
  assert.match(report.problems[0].fix, /BOXLITE_API_KEY/);
  assert.ok(report.checks.some((c: { id: string; status: string }) => c.id === 'online' && c.status === 'skipped'));
});

test('login saves the key once; later commands without BOXLITE_API_KEY use it; logout forgets it', async () => {
  const dir = await project(root, {});
  const config = await mkdtemp(join(tmpdir(), 'blcfg-'));
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me/whoami', method: 'GET', headers: { authorization: `Bearer ${KEY}` } }).reply(200, WHOAMI, { headers: JSON_HEADERS }).times(3);
  const login = await cli(['login', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_URL: API, BOXLITE_API_KEY: KEY, BOXLITE_CONFIG_DIR: config } });
  assert.equal(login.code, 0, login.stderr);
  assert.ok(!login.stdout.includes(KEY), 'the key is never printed');
  const saved = join(config, 'credentials.json');
  assert.equal((await stat(saved)).mode & 0o777, 0o600, 'readable by the user only');

  // A new shell: no key, no URL in the environment.
  const later = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } });
  assert.equal(later.code, 0, later.stderr);
  assert.equal(JSON.parse(later.stdout).app, 'crm');

  assert.equal((await cli(['logout'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } })).code, 0);
  const after = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } });
  assert.equal(JSON.parse(after.stderr).error.code, 'unauthenticated', 'nothing saved any more');
});

test('with keys of two Apps saved, a folder that names no App never borrows the other App\'s key', async () => {
  const dir = await project(root, {});
  const config = await mkdtemp(join(tmpdir(), 'blcfg-'));
  const OTHER = 'bxl_app_other_0123456789abcdef';
  const profile = (app: string, key: string) => ({ api_url: API, app, key, saved_at: '2026-10-24T00:00:00.000Z' });
  // ledger logged in last, from another agent's session on the same machine.
  await writeFile(join(config, 'credentials.json'), JSON.stringify({ profiles: { [`${API}|crm`]: profile('crm', KEY), [`${API}|ledger`]: profile('ledger', OTHER) }, last: `${API}|ledger` }));
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/whoami', method: 'GET', headers: { authorization: `Bearer ${KEY}` } }).reply(200, WHOAMI, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm', method: 'GET', headers: { authorization: `Bearer ${KEY}` } }).reply(200, { name: 'crm', envs: [{ name: 'main', status: 'new' }] }, { headers: JSON_HEADERS });

  const unnamed = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } });
  assert.equal(unnamed.code, 1, unnamed.stderr);
  const err = JSON.parse(unnamed.stderr).error;
  assert.equal(err.code, 'usage');
  assert.match(err.message, /crm, ledger/);
  assert.match(err.next, /BOXLITE_APP=<name>/);

  const named = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config, BOXLITE_APP: 'crm' } });
  assert.equal(JSON.parse(named.stdout).app, 'crm', named.stderr);
  const init = await cli(['init', '--app', 'crm', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } });
  assert.equal(init.code, 0, init.stderr);
});

test('a BoxLite platform key (blk_…) in the shell never stands in for the App key', async () => {
  const dir = await project(root, {});
  const config = await mkdtemp(join(tmpdir(), 'blcfg-'));
  const PLATFORM = 'blk_live_0123456789abcdef0123456789';
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me/whoami', method: 'GET', headers: { authorization: `Bearer ${KEY}` } }).reply(200, WHOAMI, { headers: JSON_HEADERS }).times(2);

  // Nothing saved: say what the variable is, not "key not recognised" from the server.
  const none = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_URL: API, BOXLITE_API_KEY: PLATFORM, BOXLITE_CONFIG_DIR: config } });
  const err = JSON.parse(none.stderr).error;
  assert.equal(err.code, 'unauthenticated');
  assert.match(err.message, /platform key/);
  assert.ok(!none.stderr.includes(PLATFORM), 'the key is never printed');
  const login = await cli(['login', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_URL: API, BOXLITE_API_KEY: PLATFORM, BOXLITE_CONFIG_DIR: config } });
  assert.match(JSON.parse(login.stderr).error.message, /platform key/);

  // With the App key saved, the platform key in the profile is simply not used.
  assert.equal((await cli(['login'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_URL: API, BOXLITE_API_KEY: KEY, BOXLITE_CONFIG_DIR: config } })).code, 0);
  const later = await cli(['whoami', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_KEY: PLATFORM, BOXLITE_CONFIG_DIR: config } });
  assert.equal(later.code, 0, later.stderr);
  assert.equal(JSON.parse(later.stdout).app, 'crm');
});

test('app remember, recall and forget keep notes for the next session', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  let sent: Record<string, unknown> = {};
  pool.intercept({ path: '/v1/apps/crm/notes', method: 'POST' }).reply(201, (opts) => {
    sent = JSON.parse(String(opts.body));
    return { id: 7, text: String(sent.text), by: 'key:…aaaa', created_at: '2026-10-24T10:00:00.000Z' };
  }, { headers: JSON_HEADERS });
  const kept = await cli(['app', 'remember', 'the', 'owner', 'wants', 'CNY'], { cwd: dir, dispatcher: agent });
  assert.equal(kept.code, 0, kept.stderr);
  assert.deepEqual(sent, { text: 'the owner wants CNY' });
  assert.match(kept.stdout, /kept note 7: the owner wants CNY/);
  pool.intercept({ path: '/v1/apps/crm/notes?q=cny', method: 'GET' }).reply(200, [{ id: 7, text: 'the owner wants CNY', by: 'key:…aaaa', created_at: '2026-10-24T10:00:00.000Z' }], { headers: JSON_HEADERS });
  const found = await cli(['app', 'recall', 'cny'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(found.lines, ['   7  2026-10-24  the owner wants CNY']);
  pool.intercept({ path: '/v1/apps/crm/notes/7', method: 'DELETE' }).reply(200, { forgotten: 7 }, { headers: JSON_HEADERS });
  assert.equal((await cli(['app', 'forget', '7'], { cwd: dir, dispatcher: agent })).code, 0);
  assert.equal(JSON.parse((await cli(['app', 'forget', 'x', '--json'], { cwd: dir, dispatcher: agent })).stderr).error.code, 'usage');
});

test('app ack sends the reason; app unack brings the finding back', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  let sent: Record<string, unknown> = {};
  pool.intercept({ path: '/v1/apps/crm/envs/main/findings/public_anonymous/ack', method: 'POST' }).reply(200, (opts) => {
    sent = JSON.parse(String(opts.body));
    return { id: 'public_anonymous', title: 'the app is public and has no sign-in', reason: String(sent.reason), by: 'key:…aaaa', at: '2026-10-24T10:00:00.000Z' };
  }, { headers: JSON_HEADERS });
  const r = await cli(['app', 'ack', 'public_anonymous', 'the', 'user', 'asked', 'for', 'it'], { cwd: dir, dispatcher: agent });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sent, { reason: 'the user asked for it' });
  assert.match(r.stdout, /acknowledged public_anonymous in main: the user asked for it/);
  pool.intercept({ path: '/v1/apps/crm/envs/main/findings/public_anonymous/ack', method: 'DELETE' }).reply(200, { unacknowledged: 'public_anonymous' }, { headers: JSON_HEADERS });
  assert.match((await cli(['app', 'unack', 'public_anonymous'], { cwd: dir, dispatcher: agent })).stdout, /public_anonymous is back in next_actions/);
});
