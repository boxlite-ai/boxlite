import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BASE_TOML, cleanup, cli, JSON_HEADERS, KEY, linkJson, mockApi, parseJsonLines, project, sse, SSE_HEADERS, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const E = '/v1/apps/crm/envs/main';
const linked = () => project(root, { '.boxlite/link.json': linkJson(1) });

test('app logs: level/deployment/until go to the search endpoint, grep filters locally, bad input has a next', async () => {
  const dir = await linked();
  const { agent, pool } = mockApi();
  const lines = [
    { id: 1, ts: '2026-10-21T10:00:00Z', source: 'web', level: 'error', line: 'Error: ECONNREFUSED db', deployment: 4 },
    { id: 2, ts: '2026-10-21T10:00:01Z', source: 'web', level: 'error', line: 'TypeError: x', deployment: 4 },
  ];
  pool.intercept({ path: `${E}/logs/search?source=web&level=error&since=10m&deployment=4&limit=200`, method: 'GET' }).reply(200, lines, { headers: JSON_HEADERS });
  const res = await cli(['app', 'logs', '--source', 'web', '--level', 'error', '--since', '10m', '--deployment', '4', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), lines);

  pool.intercept({ path: `${E}/logs/search?since=2h&limit=5000`, method: 'GET' }).reply(200, lines, { headers: JSON_HEADERS });
  const grep = await cli(['app', 'logs', '--grep', 'econn|timeout', '--since', '2h'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(grep.lines, ['2026-10-21T10:00:00Z  web     ! Error: ECONNREFUSED db']);

  const badLevel = await cli(['app', 'logs', '--level', 'loud', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(badLevel.code, 1);
  assert.equal(JSON.parse(badLevel.stderr).error.next, '`boxlite-app app logs --level error`');
  const badRegex = await cli(['app', 'logs', '--grep', '(', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(badRegex.stderr).error.code, 'usage');

  pool.intercept({ path: `${E}/logs?follow=1`, method: 'GET' }).reply(200, sse([{ event: 'log', data: lines[0] }, { event: 'log', data: { ...lines[1], level: 'info' } }]), { headers: SSE_HEADERS });
  const follow = await cli(['app', 'logs', '--follow', '--level', 'error', '--json'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(parseJsonLines(follow.stdout), [lines[0]]);
});

test('app deployment N --logs prints the timeline and the classified cause; JSON carries the diagnosis', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'boxlite.toml': `${BASE_TOML}[database]\n`, 'migrations/0002_deals.sql': 'create table deals (\n  title txt\n);\n', 'package-lock.json': '{}' });
  const { agent, pool } = mockApi();
  const timeline = {
    deployment: { number: 5, kind: 'deploy', status: 'failed', message: 'deals', created_at: '2026-10-21T10:00:00Z', finished_at: '2026-10-21T10:01:00Z', error: { step: 'migrate', message: 'migration 0002_deals.sql failed: type "txt" does not exist' } },
    steps: [
      { name: 'build', status: 'done', ms: 41000, detail: 'npm ci', started_at: '2026-10-21T10:00:01Z', finished_at: '2026-10-21T10:00:42Z' },
      { name: 'migrate', status: 'failed', ms: 300, detail: 'migration failed', started_at: '2026-10-21T10:00:43Z', finished_at: '2026-10-21T10:00:43Z' },
    ],
    logs: [{ id: 1, ts: '2026-10-21T10:00:02Z', source: 'build', level: 'info', line: 'added 12 packages', deployment: 5 }],
    truncated: false,
  };
  pool.intercept({ path: `${E}/deployments/5/timeline`, method: 'GET' }).reply(200, timeline, { headers: JSON_HEADERS }).times(2);
  const human = await cli(['app', 'deployment', '5', '--logs'], { cwd: dir, dispatcher: agent });
  assert.equal(human.code, 0, human.stderr);
  assert.ok(human.lines.includes('  10:00:01  build     done     41s     npm ci'), human.stdout);
  assert.ok(human.lines.includes('  10:00:02  build   added 12 packages'));
  assert.ok(human.lines.includes('Status: failed at 2026-10-21T10:01:00Z'));
  assert.equal(human.lines.at(-2), 'Cause: migration_sql_error — migrations/0002_deals.sql:2: type "txt" does not exist (migrations/0002_deals.sql:2)');
  const json = JSON.parse((await cli(['app', 'deployment', '5', '--logs', '--json'], { cwd: dir, dispatcher: agent })).stdout);
  assert.deepEqual([json.diagnosis.cause, json.diagnosis.file, json.diagnosis.line], ['migration_sql_error', 'migrations/0002_deals.sql', 2]);
  assert.equal(json.steps.length, 2);
});

test('deploy --dry-run checks, plans and sizes the upload without deploying', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'boxlite.toml': BASE_TOML, 'server.js': 'listen()', 'package-lock.json': '{}' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/plan`, method: 'POST' }).reply(200, { latest_version: 1, stale: false, changes: [], errors: [], warnings: [] }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/uploads', method: 'POST' }).reply(200, { upload_id: 'u9', missing: [(await import('node:crypto')).createHash('sha256').update('listen()').digest('hex')] }, { headers: JSON_HEADERS });
  const res = await cli(['deploy', '--dry-run', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dry_run, true);
  assert.deepEqual(out.upload, { files: 3, bytes: Buffer.byteLength(BASE_TOML) + 8 + 2, new_files: 1, new_bytes: 8 });
  agent.assertNoPendingInterceptors();
});

test('a failed deploy in --json mode: nothing on stdout, a classified error on stderr, exit 8', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'boxlite.toml': BASE_TOML, 'package.json': '{}' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/uploads', method: 'POST' }).reply(200, { upload_id: 'u3', missing: [] }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/uploads/u3/complete', method: 'POST' }).reply(200, { snapshot_id: 'snap_3', files: 2, bytes: 10 }, { headers: JSON_HEADERS });
  pool.intercept({ path: `${E}/deployments`, method: 'POST' }).reply(202, { number: 6, kind: 'deploy', status: 'queued' }, { headers: JSON_HEADERS });
  const error = { step: 'build', message: 'build step 1 (npm ci) exited with code 1', log_tail: ['t [build] npm error code EUSAGE', 't [build] npm error The `npm ci` command can only install with an existing package-lock.json'] };
  pool.intercept({ path: `${E}/deployments/6/events`, method: 'GET' }).reply(200, sse([{ event: 'done', data: { status: 'failed', deployment: { number: 6, status: 'failed', error } } }]), { headers: SSE_HEADERS });
  pool.intercept({ path: `${E}/deployments/6`, method: 'GET' }).reply(200, { number: 6, status: 'failed', error, log_tail: error.log_tail }, { headers: JSON_HEADERS });
  const res = await cli(['deploy', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 8);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr).error;
  assert.deepEqual([err.code, err.deployment, err.step, err.cause, err.file], ['deploy_failed', 6, 'build', 'missing_lockfile', 'package-lock.json']);
  assert.match(err.fix, /npm install/);
  assert.equal(err.next, err.fix);
  assert.deepEqual(err.log_tail, error.log_tail);
});

test('app vars list shows live values, masks secrets, and flags unpublished local edits', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'boxlite.toml': `${BASE_TOML}[variables]\nLOG_LEVEL = "debug"\nNEW_FLAG = "1"\n[secrets]\nOPENAI_API_KEY = "org/openai"\n`, 'package-lock.json': '{}' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/vars`, method: 'GET' }).reply(200, [
    { name: 'BOXLITE_ENV', value: 'main', secret: false, source: 'platform', resolved: true },
    { name: 'LOG_LEVEL', value: 'info', secret: false, source: 'boxlite.toml', resolved: true },
    { name: 'OPENAI_API_KEY', value: null, secret: true, source: 'secret org/openai', resolved: true },
  ], { headers: JSON_HEADERS }).times(2);
  const human = await cli(['app', 'vars', 'list'], { cwd: dir, dispatcher: agent });
  assert.equal(human.code, 0, human.stderr);
  assert.deepEqual(human.lines, [
    'BOXLITE_ENV     main      platform',
    'LOG_LEVEL       info      boxlite.toml       local: changed, not published',
    'OPENAI_API_KEY  ********  secret org/openai',
    'NEW_FLAG        1         boxlite.toml       local: added, not published',
    'next: `boxlite-app plan`, then `boxlite-app apply --yes` (or `deploy`) to publish',
  ]);
  const json = JSON.parse((await cli(['app', 'vars', 'list', '--json'], { cwd: dir, dispatcher: agent })).stdout);
  assert.deepEqual(json.find((v: { name: string }) => v.name === 'LOG_LEVEL').local_change, 'changed');
});

test('app schedule list shows the next run and the last result', async () => {
  const dir = await linked();
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/schedules`, method: 'GET' }).reply(200, [{ name: 'daily', cron: '0 9 * * *', target: 'web:/jobs/daily', next_run: '2026-10-22T09:00:00.000Z', last_run: new Date().toISOString(), last_status: 500 }], { headers: JSON_HEADERS });
  const res = await cli(['app', 'schedule', 'list'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.lines[0], 'daily  0 9 * * *  web:/jobs/daily  next 2026-10-22T09:00:00.000Z  last 0s ago → 500');
  assert.equal(res.lines[1], 'next: `boxlite-app app logs --source schedule --grep daily`, then `boxlite-app app schedule run daily`');
});

test('app volume ls and cp in both directions', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'logo.png': 'PNG' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/volumes`, method: 'GET' }).reply(200, [{ name: 'uploads', mount: '/data/uploads', mode: 'rw' }], { headers: JSON_HEADERS });
  const vols = await cli(['app', 'volume', 'ls'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(vols.lines, ['uploads  /data/uploads  rw', 'next: `boxlite-app app volume ls uploads` lists its files']);

  pool.intercept({ path: `${E}/volumes/uploads/files?path=%2Favatars`, method: 'GET' }).reply(200, { volume: 'uploads', path: '/avatars', type: 'dir', entries: [{ name: 'me.png', type: 'file', size: 2048, mode: '-rw-r--r--', modified_at: '2026-10-21T10:00:00Z' }, { name: 'old', type: 'dir', size: 0, mode: 'drwxr-xr-x', modified_at: '2026-10-21T10:00:00Z' }] }, { headers: JSON_HEADERS });
  const listing = await cli(['app', 'volume', 'ls', 'uploads:/avatars'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(listing.lines, ['me.png  2.0 kB  -rw-r--r--  2026-10-21T10:00:00Z', 'old/            drwxr-xr-x  2026-10-21T10:00:00Z']);

  let uploaded = '';
  pool.intercept({ path: `${E}/volumes/uploads/files?path=%2Fbrand%2Flogo.png`, method: 'PUT', body: (b) => ((uploaded = Buffer.from(b as unknown as Uint8Array).toString()), true) }).reply(200, { volume: 'uploads', path: '/brand/logo.png', bytes: 3, replaced: false }, { headers: JSON_HEADERS });
  const up = await cli(['app', 'volume', 'cp', 'logo.png', 'uploads:/brand/'], { cwd: dir, dispatcher: agent });
  assert.equal(up.code, 0, up.stderr);
  assert.equal(uploaded, 'PNG');
  assert.deepEqual(up.lines, ['logo.png → uploads:/brand/logo.png (3 B)']);

  pool.intercept({ path: `${E}/volumes/uploads/files?path=%2Fexports%2Freport.csv`, method: 'GET' }).reply(200, 'a,b\n1,2\n', { headers: { 'content-type': 'application/octet-stream' } }).times(2);
  const down = await cli(['app', 'volume', 'cp', 'uploads:/exports/report.csv', '.', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(down.code, 0, down.stderr);
  assert.equal(JSON.parse(down.stdout).bytes, 8);
  assert.equal(await readFile(join(dir, 'report.csv'), 'utf8'), 'a,b\n1,2\n');
  const again = await cli(['app', 'volume', 'cp', 'uploads:/exports/report.csv', '.', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(again.stderr).error.code, 'exists');
  assert.match(JSON.parse(again.stderr).error.next, /--force/);

  const both = await cli(['app', 'volume', 'cp', 'a', 'b', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(both.stderr).error.code, 'usage');
});

test('app curl sends the App key to the app URL only, adds a test session with --as, and shows redirects', async () => {
  const dir = await linked();
  const { agent, pool } = mockApi();
  const app = agent.get('https://app.test');
  pool.intercept({ path: E, method: 'GET' }).reply(200, { name: 'main', url: 'https://app.test/crm' }, { headers: JSON_HEADERS }).times(8);
  let seen: Record<string, string> = {};
  app.intercept({ path: '/crm/healthz', method: 'GET', headers: (h) => ((seen = h as Record<string, string>), true) }).reply(200, 'ok', { headers: { 'content-type': 'text/plain' } });
  const res = await cli(['app', 'curl', '/healthz'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(seen.authorization, `Bearer ${KEY}`);
  assert.match(res.lines[0] ?? '', /^HTTP 200 OK  GET https:\/\/app\.test\/crm\/healthz  \d+ ms$/);
  assert.equal(res.lines.at(-1), 'ok');
  assert.ok(!res.stdout.includes(KEY));

  pool.intercept({ path: `${E}/auth/test-sessions`, method: 'POST' }).reply(201, { cookie: 'bxl_s_crm=tok', expires_in: '15m', expires_at: '2026-10-21T10:15:00Z', user: { email: 'qa@example.com' } }, { headers: JSON_HEADERS });
  let cookie = '';
  let body = '';
  app.intercept({ path: '/crm/api/items', method: 'POST', headers: (h) => ((cookie = String((h as Record<string, string>).cookie)), true), body: (b) => ((body = String(b)), true) }).reply(201, { id: 7 }, { headers: { 'content-type': 'application/json' } });
  const post = await cli(['app', 'curl', '/api/items', '-d', '{"title":"x"}', '--as', 'qa@example.com', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(post.code, 0, post.stderr);
  const out = JSON.parse(post.stdout);
  assert.deepEqual([out.method, out.status, out.body_json, out.as.email], ['POST', 201, { id: 7 }, 'qa@example.com']);
  assert.equal(out.body, undefined, 'a JSON body is given once, parsed');
  assert.equal(cookie, 'bxl_s_crm=tok');
  assert.equal(body, '{"title":"x"}');

  app.intercept({ path: '/crm/app', method: 'GET' }).reply(302, '', { headers: { location: '/crm/.boxlite/auth/login?next=/app' } });
  const redirect = await cli(['app', 'curl', '/app'], { cwd: dir, dispatcher: agent });
  assert.match(redirect.lines[0] ?? '', /^HTTP 302/);
  assert.match(redirect.lines.at(-1) ?? '', /^next: follow it: `boxlite-app app curl \/crm\/\.boxlite\/auth\/login\?next=\/app`/);

  // A sign-in redirect is a success with a redirect, its session cookie redacted; --expect asserts it.
  const login = { location: 'https://cp.test/auth/start?app=crm', 'set-cookie': '__Host-bxl_login=secret-nonce; Path=/; HttpOnly; SameSite=Lax' };
  app.intercept({ path: '/crm/.boxlite/auth/login', method: 'GET' }).reply(302, '', { headers: login }).times(2);
  const ok = JSON.parse((await cli(['app', 'curl', '/.boxlite/auth/login', '--expect', '302', '--json'], { cwd: dir, dispatcher: agent })).stdout);
  assert.deepEqual([ok.ok, ok.redirect, ok.as_expected], [true, 'https://cp.test/auth/start?app=crm', true]);
  assert.deepEqual(ok.headers['set-cookie'], ['__Host-bxl_login=<redacted>; Path=/; HttpOnly; SameSite=Lax']);
  const wrong = await cli(['app', 'curl', '/.boxlite/auth/login', '--expect', '200', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(wrong.code, 1);
  assert.equal(JSON.parse(wrong.stderr).error.code, 'http_unexpected');
  assert.ok(!wrong.stderr.includes('secret-nonce') && !wrong.stdout.includes('secret-nonce'));

  app.intercept({ path: '/crm/api/board', method: 'GET' }).reply(200, { top: ['ann'] }, { headers: { 'content-type': 'application/json' } });
  const only = await cli(['app', 'curl', '/api/board', '--body', '--json'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(JSON.parse(only.stdout), { top: ['ann'] }, '--body is the body alone');

  const foreign = await cli(['app', 'curl', 'https://evil.test/steal', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(foreign.code, 1);
  assert.match(JSON.parse(foreign.stderr).error.message, /evil\.test is not this environment's URL/);
});

test('app open asks for a one-time ticket and prints it without a terminal', async () => {
  const dir = await linked();
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/open-ticket`, method: 'POST' }).reply(200, { url: 'https://app.test/crm/?ticket=t1', expires_at: '2026-10-21T10:05:00Z' }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'open', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { url: 'https://app.test/crm/?ticket=t1', expires_at: '2026-10-21T10:05:00Z', opened: false, as: null });
  // Signed in as a test user, for checking signed-in pages in a browser.
  let sent: Record<string, unknown> = {};
  pool.intercept({ path: `${E}/open-ticket`, method: 'POST', body: (b) => ((sent = JSON.parse(b)), true) }).reply(200, { url: 'https://app.test/crm/?ticket=t2' }, { headers: JSON_HEADERS });
  const as = await cli(['app', 'open', '--as', 'qa@example.com', '--role', 'owner', '--path', '/app', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(as.code, 0, as.stderr);
  assert.deepEqual(sent, { next: '/app', as: 'qa@example.com', role: 'owner' });
  assert.deepEqual(JSON.parse(as.stdout).as, { email: 'qa@example.com', role: 'owner' });
  pool.intercept({ path: `${E}/open-ticket`, method: 'POST' }).reply(404, { error: { code: 'not_found', message: 'no route' } }, { headers: JSON_HEADERS });
  const old = await cli(['app', 'open', '--print-url', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(old.stderr).error.code, 'not_supported_yet');
});

test('destructive commands in --json mode without --yes return confirmation_required with the exact command', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1, 'dev') });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/dev/db/schema', method: 'GET' }).reply(200, { tables: [{ name: 'deals' }] }, { headers: JSON_HEADERS });
  const reset = await cli(['app', 'db', 'reset', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(reset.code, 10);
  const err = JSON.parse(reset.stderr).error;
  assert.equal(err.code, 'confirmation_required');
  assert.equal(err.command, 'boxlite-app app db reset --json --yes');
  assert.match(err.destroys[0], /tables deals and every row in them/);
  assert.equal(err.docs, 'boxlite-app docs rules');

  const restore = await cli(['app', 'db', 'restore', '--to', '2026-10-21T09:00:00Z', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(restore.stderr).error.command, "boxlite-app app db restore --to 2026-10-21T09:00:00Z --json --yes");
  const rollback = await cli(['app', 'rollback', '3', '--with-database', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(rollback.code, 10);
  const mainReset = await cli(['app', 'db', 'reset', '--env', 'main', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(mainReset.code, 5);
  assert.match(JSON.parse(mainReset.stderr).error.next, /db restore --to/);
  agent.assertNoPendingInterceptors();
});

test('secrets never reach the output: App keys and database passwords are masked everywhere', async () => {
  const dir = await linked();
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/logs`, method: 'GET' }).reply(200, [{ ts: 't', source: 'web', level: 'info', line: `connecting to postgresql://neondb_owner:hunter2@ep-x.neon.tech/neondb with ${KEY}` }], { headers: JSON_HEADERS }).times(2);
  for (const json of [false, true]) {
    const res = await cli(['app', 'logs', ...(json ? ['--json'] : [])], { cwd: dir, dispatcher: agent });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stdout.includes('hunter2') && !res.stdout.includes(KEY), res.stdout);
    assert.match(res.stdout, /postgresql:\/\/neondb_owner:\*\*\*\*@ep-x\.neon\.tech/);
    assert.match(res.stdout, new RegExp(`bxl_app_…${KEY.slice(-4)}`));
  }
  pool.intercept({ path: `${E}/services`, method: 'GET' }).reply(500, { error: { code: 'internal', message: `boom ${KEY}` } }, { headers: JSON_HEADERS });
  const err = await cli(['app', 'services', '--json'], { cwd: dir, dispatcher: agent });
  assert.ok(!err.stderr.includes(KEY));
});
