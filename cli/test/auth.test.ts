import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanup, cli, JSON_HEADERS, linkJson, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const E = '/v1/apps/crm/envs/main/auth';
const mona = { id: '7d3c…', email: 'mona@example.com', name: 'Mona', provider: 'github', blocked: false, last_seen: new Date().toISOString(), active_sessions: 1 };
const monaG = { ...mona, id: 'g-1', provider: 'google' };

test('app auth status, human and --json', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const body = { enabled: true, providers: [{ name: 'github', status: 'ready' }, { name: 'google', status: 'not_configured' }], protect: ['/app/*'], login_url: 'https://cp.test/crm/.boxlite/auth/login', users: 3 };
  pool.intercept({ path: E, method: 'GET' }).reply(200, body, { headers: JSON_HEADERS }).times(2);
  const human = await cli(['app', 'auth', 'status'], { cwd: dir, dispatcher: agent });
  assert.equal(human.code, 0, human.stderr);
  assert.deepEqual(human.lines, [
    'sign-in on · github ready · google not configured on this platform yet',
    '  protect  /app/*',
    '  login    https://cp.test/crm/.boxlite/auth/login',
    '  users    3',
    'next: `boxlite-app app auth test-session --email qa@example.com` signs in a test user for curl checks',
  ]);
  const json = await cli(['app', 'auth', 'status', '--json'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(JSON.parse(json.stdout), body);
});

test('app auth redirect-uris and users --search', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/redirect-uris`, method: 'GET' }).reply(200, [{ provider: 'github', redirect_uri: 'https://cp.test/auth/callback/github', status: 'ready' }], { headers: JSON_HEADERS });
  const uris = await cli(['app', 'auth', 'redirect-uris'], { cwd: dir, dispatcher: agent });
  assert.equal(uris.code, 0, uris.stderr);
  assert.deepEqual(uris.lines[0], 'github  https://cp.test/auth/callback/github  ready');

  pool.intercept({ path: `${E}/users?search=mona`, method: 'GET' }).reply(200, [mona], { headers: JSON_HEADERS });
  const users = await cli(['app', 'auth', 'users', '--search', 'mona', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(users.code, 0, users.stderr);
  assert.deepEqual(JSON.parse(users.stdout), [mona]);
});

test('app auth users block <email> resolves every user with that email', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/users?search=mona%40example.com`, method: 'GET' }).reply(200, [mona, monaG, { ...mona, id: 'x', email: 'mona@example.com.au' }], { headers: JSON_HEADERS });
  pool.intercept({ path: `${E}/users/${encodeURIComponent(mona.id)}/block`, method: 'POST' }).reply(200, { ...mona, blocked: true }, { headers: JSON_HEADERS });
  pool.intercept({ path: `${E}/users/g-1/block`, method: 'POST' }).reply(200, { ...monaG, blocked: true }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'auth', 'users', 'block', 'mona@example.com'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.lines, ['mona@example.com (github): blocked, sessions revoked', 'mona@example.com (google): blocked, sessions revoked']);

  pool.intercept({ path: `${E}/users?search=nobody%40example.com`, method: 'GET' }).reply(200, [], { headers: JSON_HEADERS });
  const missing = await cli(['app', 'auth', 'users', 'signout', 'nobody@example.com', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(missing.code, 4);
  assert.equal(JSON.parse(missing.stderr).error.code, 'not_found');

  const usage = await cli(['app', 'auth', 'users', 'delete', 'x@y'], { cwd: dir, dispatcher: agent });
  assert.notEqual(usage.code, 0);
});

test('app auth users signout and export', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/users?search=mona%40example.com`, method: 'GET' }).reply(200, [mona], { headers: JSON_HEADERS });
  pool.intercept({ path: `${E}/users/${encodeURIComponent(mona.id)}/signout`, method: 'POST' }).reply(200, { ...mona, revoked: 2, active_sessions: 0 }, { headers: JSON_HEADERS });
  const out = await cli(['app', 'auth', 'users', 'signout', 'mona@example.com'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(out.lines, ['mona@example.com (github): signed out (2 sessions)']);

  const csv = 'id,email,name,provider,first_seen,last_seen,blocked\n1,mona@example.com,Mona,github,a,b,false\n';
  pool.intercept({ path: `${E}/users/export`, method: 'GET' }).reply(200, csv, { headers: { 'content-type': 'text/csv' } });
  const exp = await cli(['app', 'auth', 'users', 'export'], { cwd: dir, dispatcher: agent });
  assert.equal(exp.code, 0, exp.stderr);
  assert.equal(exp.stdout, csv);
});

test('app auth test-session --email prints the cookie; --json returns the API body', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const body = { cookie: 'bxl_s_crm=tok', cookie_name: 'bxl_s_crm', expires_in: '15m', expires_at: '2026-10-21T10:15:00Z', user: { ...mona, email: 'qa@example.com', provider: 'test' } };
  pool.intercept({ path: `${E}/test-sessions`, method: 'POST', body: JSON.stringify({ email: 'qa@example.com' }) }).reply(201, body, { headers: JSON_HEADERS }).times(2);
  const json = await cli(['app', 'auth', 'test-session', '--email', 'qa@example.com', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), body);
  const human = await cli(['app', 'auth', 'test-session', '--email', 'qa@example.com'], { cwd: dir, dispatcher: agent });
  assert.equal(human.lines[0], 'test user qa@example.com · expires in 15m');
  assert.equal(human.lines[1], 'cookie: bxl_s_crm=tok');

  const noEmail = await cli(['app', 'auth', 'test-session'], { cwd: dir, dispatcher: agent });
  assert.notEqual(noEmail.code, 0);
});

test('app auth email set takes the password from stdin only and never prints it', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  let sent: Record<string, unknown> = {};
  pool
    .intercept({ path: '/v1/apps/crm/auth/email', method: 'PUT' })
    .reply(200, (opts) => {
      sent = JSON.parse(String(opts.body));
      return { configured: true, host: 'smtp.acme.com', port: 587, username: 'apikey', from: 'Acme <no-reply@acme.com>', password_set: true };
    }, { headers: JSON_HEADERS });
  const r = await cli(['app', 'auth', 'email', 'set', '--host', 'smtp.acme.com', '--username', 'apikey', '--from', 'Acme <no-reply@acme.com>', '--password-stdin'], { cwd: dir, dispatcher: agent, stdin: 'S3cr3t-smtp\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sent, { host: 'smtp.acme.com', port: 587, username: 'apikey', from: 'Acme <no-reply@acme.com>', password: 'S3cr3t-smtp' });
  assert.ok(!r.stdout.includes('S3cr3t') && !r.stderr.includes('S3cr3t'));
  assert.match(r.stdout, /sender set: smtp\.acme\.com:587/);
  const missing = await cli(['app', 'auth', 'email', 'set', '--host', 'smtp.acme.com', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(missing.stderr).error.code, 'usage');
});
