import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { API, BASE_TOML, cleanup, cli, JSON_HEADERS, KEY, linkJson, mockApi, parseJsonLines, project, sse, SSE_HEADERS, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('init in a new project creates .gitignore so .env.local is never committed', async () => {
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me', method: 'GET' }).reply(200, { name: 'crm', envs: [{ name: 'main', status: 'live', spec_version: 2 }] }, { headers: JSON_HEADERS });
  const dir = await project(root, {});
  const r = await cli(['init', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).created.includes('.gitignore'));
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '.boxlite/\n.env.local\n');
});

test('init writes boxlite.toml, link.json and .gitignore entries, and is idempotent', async () => {
  const { agent, pool } = mockApi();
  pool
    .intercept({ path: '/v1/apps/me', method: 'GET', headers: { authorization: `Bearer ${KEY}` } })
    .reply(200, { name: 'crm', envs: [{ name: 'main', status: 'live', spec_version: 2 }] }, { headers: JSON_HEADERS });
  // Once linked, init resolves the App from link.json instead of `me`.
  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(200, { name: 'crm', envs: [{ name: 'main', status: 'live', spec_version: 2 }] }, { headers: JSON_HEADERS });
  const dir = await project(root, { '.gitignore': 'node_modules/\n' });

  const first = await cli(['init'], { cwd: dir, dispatcher: agent });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.lines, [
    `App crm · environment main · ${API}`,
    '  created    boxlite.toml',
    '  created    .boxlite/link.json',
    '  created    .gitignore (+.boxlite/, .env.local)',
    '  created    AGENTS.md',
    'next: edit boxlite.toml (`boxlite-app docs manifest`), then `boxlite-app check` and `boxlite-app deploy`',
  ]);
  assert.match(await readFile(join(dir, 'AGENTS.md'), 'utf8'), /<!-- BOXLITE:START -->\n## BoxLite App[\s\S]*boxlite-app doctor[\s\S]*<!-- BOXLITE:END -->/);
  const toml = await readFile(join(dir, 'boxlite.toml'), 'utf8');
  assert.match(toml, /^\[app\]\nname = "crm"$/m);
  assert.match(toml, /\[\[service\]\]\nname = "web"\ncommand = "npm start"/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.boxlite/link.json'), 'utf8')), { app: 'crm', env: 'main', base_version: 2, api_url: API });
  assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.boxlite/\n.env.local\n');

  const second = await cli(['init', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(second.code, 0);
  assert.deepEqual(JSON.parse(second.stdout), { app: 'crm', env: 'main', base_version: 2, api_url: API, created: [], unchanged: ['boxlite.toml', '.boxlite/link.json', '.gitignore', 'AGENTS.md'] });
  assert.equal(await readFile(join(dir, 'boxlite.toml'), 'utf8'), toml);

  const fresh = await cli(['check'], { cwd: dir, env: { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: API } });
  assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
});

test('check reports errors as JSON with exit 7 and never touches the network', async () => {
  const dir = await project(root, { 'boxlite.toml': 'name = "crm"\n[runtime]\nimage = "node"\nsiz = "small"\n[[service]]\nname = "web"\ncommand = "x"\n' });
  const { agent } = mockApi();
  const res = await cli(['check', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 7);
  // One JSON document per run: failures go to stderr only.
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr).error;
  assert.equal(err.code, 'invalid_manifest');
  assert.deepEqual(err.errors, [
    { file: 'boxlite.toml', line: 4, rule: 'unknown_field', message: 'unknown field "runtime.siz"' },
    { file: 'boxlite.toml', line: 5, rule: 'no_exposed_service', message: 'exactly one service must be exposed: set port = <int> or static = "dir/" on it' },
  ]);
  assert.equal(err.next, 'fix boxlite.toml:4: unknown field "runtime.siz"; then `boxlite-app check`');
  assert.equal(err.docs, 'boxlite-app docs manifest');
  assert.equal('printed' in err, false);

  const human = await cli(['check'], { cwd: dir });
  assert.equal(human.code, 7);
  assert.equal(human.lines[0], 'boxlite.toml:4  unknown_field  unknown field "runtime.siz"');
  assert.equal(human.lines.at(-1), '2 errors, 0 warnings');
});

test('plan prints the PRD layout, exits 9 when stale, and --force proceeds', async () => {
  const dir = await project(root, {
    'boxlite.toml': `${BASE_TOML}[database]\n[variables]\nLOG_LEVEL = "info"\n`,
    '.boxlite/link.json': linkJson(1),
    '.env.local': 'SECRET=1',
    'migrations/0001_init.sql': 'create table deals();',
    'package.json': '{}',
    'package-lock.json': '{}',
  });
  const { agent, pool } = mockApi();
  let body: Record<string, unknown> | undefined;
  const planResponse = {
    latest_version: 1,
    stale: false,
    changes: [
      { kind: '+', path: 'database', to: 'neon branch main, run migrations/0001_init.sql' },
      { kind: '~', path: 'variables.LOG_LEVEL', from: null, to: 'info' },
      { kind: 'online_only', path: 'domains.custom', to: 'crm.acme.com' },
    ],
    errors: [],
    warnings: [],
  };
  pool
    .intercept({ path: '/v1/apps/crm/envs/main/plan', method: 'POST', body: (b) => ((body = JSON.parse(b)), true) })
    .reply(200, planResponse, { headers: JSON_HEADERS });

  // Code is a separate question: the platform says which files it does not have yet.
  pool.intercept({ path: '/v1/apps/crm/uploads', method: 'POST' }).reply(201, { upload_id: 'u1', missing: [sha('{}')] }, { headers: JSON_HEADERS }).times(2);
  const res = await cli(['plan'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.lines, [
    'App crm · environment main · based on v1 (latest v1)',
    '  + database        neon branch main, run migrations/0001_init.sql',
    '  ~ variables       LOG_LEVEL: (none) → info',
    '  ! online only     domains.custom: crm.acme.com   (run `boxlite-app app pull`)',
    '  snapshot          4 files, 200 B (everything a deploy contains) · warning: .env.local looks like a secret file (excluded)',
    '  code              2 of 4 files new or changed · 2 B to upload',
    'next: `boxlite-app deploy -m "<what changed>"` makes these changes and ships the code',
  ]);
  assert.ok(body);
  assert.equal(body.base_version, 1);
  assert.deepEqual(body.migrations, [{ file: '0001_init.sql', sha256: sha('create table deals();'), sql: 'create table deals();' }]);
  const manifest = body.manifest as Record<string, unknown>;
  assert.equal(manifest.app, 'crm');
  assert.deepEqual(manifest.database, { migrations: 'migrations/' });
  assert.deepEqual(body.upload, { files: 4, bytes: 200, warnings: ['.env.local looks like a secret file (excluded)'] });

  pool.intercept({ path: '/v1/apps/crm/envs/main/plan', method: 'POST' }).reply(200, { ...planResponse, latest_version: 3, stale: true }, { headers: JSON_HEADERS }).times(2);
  const stale = await cli(['plan', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(stale.code, 9);
  assert.equal(stale.stdout, '');
  const staleErr = JSON.parse(stale.stderr).error;
  assert.equal(staleErr.code, 'stale_base');
  assert.equal(staleErr.latest_version, 3);
  assert.match(staleErr.next, /boxlite-app app pull/);
  const forced = await cli(['plan', '--force'], { cwd: dir, dispatcher: agent });
  assert.equal(forced.code, 0);
  assert.equal(forced.lines[0], 'App crm · environment main · based on v1 (latest v3) · stale');
});

test('plan surfaces control-plane errors with exit 7', async () => {
  const dir = await project(root, { 'boxlite.toml': BASE_TOML, '.boxlite/link.json': linkJson(1), 'package-lock.json': '' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/main/plan', method: 'POST' }).reply(422, { error: { code: 'invalid_manifest', message: 'size too large for plan', next: 'pick small', errors: [{ file: 'boxlite.toml', line: 4, rule: 'invalid_size', message: 'large needs a paid plan' }] } }, { headers: JSON_HEADERS });
  const res = await cli(['plan'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 7);
  assert.match(res.stderr, /error: size too large for plan\n  boxlite.toml:4  invalid_size  large needs a paid plan\n  next: pick small/);
});

test('deploy uploads only missing files, follows SSE steps and updates link.json', async () => {
  const files = { 'boxlite.toml': BASE_TOML, 'server.js': 'listen()', 'lib/util.js': 'util', 'package-lock.json': '{}' };
  const dir = await project(root, { ...files, '.boxlite/link.json': linkJson(1), 'node_modules/x.js': 'ignored' });
  const { agent, pool } = mockApi();
  const put: string[] = [];
  let deployBody: Record<string, unknown> | undefined;
  let idempotencyKey: string | undefined;

  pool
    .intercept({ path: '/v1/apps/crm/uploads', method: 'POST', body: (b) => JSON.parse(b).manifest.length === 4 })
    .reply(200, { upload_id: 'u1', missing: [sha('listen()'), sha('util')] }, { headers: JSON_HEADERS });
  pool
    .intercept({ path: /\/v1\/apps\/crm\/uploads\/u1\/files\/[0-9a-f]{64}$/, method: 'PUT' })
    .reply((opts) => {
      put.push(Buffer.from(opts.body as Uint8Array).toString());
      return { statusCode: 200, data: '{}' };
    })
    .times(2);
  pool.intercept({ path: '/v1/apps/crm/uploads/u1/complete', method: 'POST' }).reply(200, { snapshot_id: 'snap_1', files: 4, bytes: 123 }, { headers: JSON_HEADERS });
  pool
    .intercept({
      path: '/v1/apps/crm/envs/main/deployments',
      method: 'POST',
      headers: (h) => ((idempotencyKey = h['idempotency-key']), true),
      body: (b) => ((deployBody = JSON.parse(b)), true),
    })
    .reply(202, { number: 2, kind: 'deploy', status: 'queued' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/2/events', method: 'GET' }).reply(
    200,
    sse([
      { id: '1', event: 'step', data: { name: 'upload', status: 'done', ms: 1200 } },
      { id: '2', event: 'step', data: { name: 'build', status: 'running' } },
      { id: '3', event: 'log', data: { ts: 't', source: 'build', line: 'added 12 packages' } },
      { id: '4', event: 'step', data: { name: 'build', status: 'done', ms: 41000 } },
      { id: '5', event: 'step', data: { name: 'start', status: 'done', ms: 3000, detail: 'web healthy' } },
      { id: '6', event: 'done', data: { status: 'live', deployment: { number: 2, kind: 'deploy', status: 'live', spec_version: 3, url: 'https://cp.test/crm' } } },
    ]),
    { headers: SSE_HEADERS },
  );

  const res = await cli(['deploy', '-m', 'Drag deals'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.lines, [
    'Uploading 2 files changed (12 B)',
    'Deployment #2 started · Drag deals',
    '#2  Uploading   2 files   1s',
    '#2  Building    npm ci && npm run build   41s',
    '#2  Starting    web healthy   3s',
    '#2  Live        https://cp.test/crm · spec v3',
    'next: verify it: `boxlite-app app curl /` and the pages the user asked for (`--as qa@example.com` for signed-in pages); `boxlite-app app logs --since 5m` shows what the app printed',
  ]);
  assert.deepEqual(put.sort(), ['listen()', 'util']);
  assert.ok(idempotencyKey && idempotencyKey.length > 10);
  assert.ok(deployBody);
  assert.equal(deployBody.kind, 'deploy');
  assert.equal(deployBody.snapshot_id, 'snap_1');
  assert.equal(deployBody.message, 'Drag deals');
  assert.equal(deployBody.base_version, 1);
  assert.deepEqual(deployBody.migrations, []);
  assert.equal((deployBody.manifest as { app: string }).app, 'crm');
  assert.equal(JSON.parse(await readFile(join(dir, '.boxlite/link.json'), 'utf8')).base_version, 3);
  agent.assertNoPendingInterceptors();
});

test('deploy failure exits 8 with the step and log tail; --detach returns early', async () => {
  const dir = await project(root, { 'boxlite.toml': BASE_TOML, '.boxlite/link.json': linkJson(1), 'package-lock.json': '' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/uploads', method: 'POST' }).reply(200, { upload_id: 'u2', missing: [] }, { headers: JSON_HEADERS }).times(2);
  pool.intercept({ path: '/v1/apps/crm/uploads/u2/complete', method: 'POST' }).reply(200, { snapshot_id: 'snap_2', files: 2, bytes: 10 }, { headers: JSON_HEADERS }).times(2);
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments', method: 'POST' }).reply(202, { number: 3, kind: 'deploy', status: 'queued' }, { headers: JSON_HEADERS }).times(2);
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/3/events', method: 'GET' }).reply(
    200,
    sse([
      { event: 'step', data: { name: 'build', status: 'failed', ms: 900 } },
      { event: 'done', data: { status: 'failed', deployment: { number: 3, status: 'failed', error: { step: 'build', message: 'build step 2 (npm run build) exited with code 1', log_tail: ['error TS2322', 'npm ERR! code 1'] } } } },
    ]),
    { headers: SSE_HEADERS },
  );
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/3', method: 'GET' }).reply(200, { number: 3, status: 'failed', error: { step: 'build', message: 'build step 2 (npm run build) exited with code 1', log_tail: ['error TS2322', 'npm ERR! code 1'] }, log_tail: ['t [build] > tsc', 't [build] error TS2322', 't [build] npm ERR! code 1'] }, { headers: JSON_HEADERS });

  const res = await cli(['deploy'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 8);
  assert.deepEqual(res.lines, ['Nothing new to upload', 'Deployment #3 started', '#3  Building    npm ci && npm run build   failed   900ms']);
  assert.equal(
    res.stderr,
    [
      'error: deployment #3 failed at build: build command `npm run build` exited with code 1',
      '  last 3 log lines:',
      '    t [build] > tsc',
      '    t [build] error TS2322',
      '    t [build] npm ERR! code 1',
      '  cause: build_command_failed (step build)',
      '  the previous live release, if any, keeps serving',
      '  next: run `npm run build` locally, fix the first error shown in the log lines, then `boxlite-app deploy`',
      '  docs: boxlite-app docs deploy',
      '',
    ].join('\n'),
  );
  assert.equal(JSON.parse(await readFile(join(dir, '.boxlite/link.json'), 'utf8')).base_version, 1);

  const detached = await cli(['deploy', '--detach', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(detached.code, 0, detached.stderr);
  assert.deepEqual(JSON.parse(detached.stdout), { number: 3, kind: 'deploy', status: 'queued' });
});

test('apply confirms, posts kind=apply with migrations and prints the provision line', async () => {
  const dir = await project(root, { 'boxlite.toml': `${BASE_TOML}[database]\n`, '.boxlite/link.json': linkJson(1), 'migrations/0001_init.sql': 'create table a();', 'package-lock.json': '' });
  const { agent, pool } = mockApi();
  const plan = { latest_version: 1, stale: false, changes: [{ kind: '+', path: 'database', to: 'neon branch main' }, { kind: '+', path: 'volumes.uploads', to: '/data/uploads' }], errors: [], warnings: [] };
  pool.intercept({ path: '/v1/apps/crm/envs/main/plan', method: 'POST' }).reply(200, plan, { headers: JSON_HEADERS }).times(2);
  let body: Record<string, unknown> | undefined;
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments', method: 'POST', body: (b) => ((body = JSON.parse(b)), true) }).reply(202, { number: 1, kind: 'apply', status: 'queued' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/1/events', method: 'GET' }).reply(200, sse([{ event: 'done', data: { status: 'live', deployment: { number: 1, kind: 'apply', status: 'live', spec_version: 2 } } }]), { headers: SSE_HEADERS });

  const refused = await cli(['apply'], { cwd: dir, dispatcher: agent });
  assert.equal(refused.code, 10);
  assert.match(refused.stderr, /refusing to apply without --yes\n  next: rerun as `boxlite-app apply --yes`/);

  // The first apply readies resources only: nothing is deployed, so it must not read as live.
  pool.intercept({ path: '/v1/apps/crm/envs/main', method: 'GET' }).reply(200, { name: 'main', live_deployment: null }, { headers: JSON_HEADERS });
  const res = await cli(['apply', '--yes'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.lines.at(-3), '#1  Provision database, volumes.uploads               applied · spec v2');
  assert.match(res.lines.at(-2) ?? '', /^not serving yet: resources are ready, but no code is deployed/);
  assert.match(res.lines.at(-1) ?? '', /^next: the app is not live until you `boxlite-app deploy`/);
  assert.equal(body?.kind, 'apply');
  assert.equal((body?.migrations as unknown[]).length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, '.boxlite/link.json'), 'utf8')).base_version, 2);
});

test('app logs --follow streams SSE log events; app logs lists', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/main/logs?source=web&since=1h&follow=1', method: 'GET' }).reply(
    200,
    sse([
      { event: 'log', data: { ts: '2026-10-21T10:00:00Z', source: 'web', line: 'listening on 3000' } },
      { event: 'log', data: { ts: '2026-10-21T10:00:01Z', source: 'web', line: 'GET / 200' } },
    ]),
    { headers: SSE_HEADERS },
  );
  pool.intercept({ path: '/v1/apps/crm/envs/main/logs?limit=2', method: 'GET' }).reply(200, { lines: [{ ts: 't1', source: 'worker', line: 'tick' }] }, { headers: JSON_HEADERS });

  const follow = await cli(['app', 'logs', '--follow', '--source', 'web', '--since', '1h'], { cwd: dir, dispatcher: agent });
  assert.equal(follow.code, 0, follow.stderr);
  assert.deepEqual(follow.lines, ['2026-10-21T10:00:00Z  web     listening on 3000', '2026-10-21T10:00:01Z  web     GET / 200']);

  const list = await cli(['app', 'logs', '--limit', '2', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(list.code, 0);
  assert.deepEqual(parseJsonLines(list.stdout), [[{ ts: 't1', source: 'worker', line: 'tick' }]]);
});

test('API errors map to exit codes and JSON envelopes; network failure is unavailable', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(401, { error: { code: 'unauthenticated', message: 'bad key', next: 'check BOXLITE_API_KEY' } }, { headers: JSON_HEADERS });
  const unauth = await cli(['app', 'status', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(unauth.code, 2);
  assert.equal(unauth.stdout, '');
  assert.deepEqual(JSON.parse(unauth.stderr), { error: { code: 'unauthenticated', message: 'bad key', next: 'check BOXLITE_API_KEY', docs: 'boxlite-app docs setup' } });

  pool.intercept({ path: '/v1/apps/crm/envs/main/services', method: 'GET' }).reply(404, 'nope');
  const notFound = await cli(['app', 'services'], { cwd: dir, dispatcher: agent });
  assert.equal(notFound.code, 4);

  pool.intercept({ path: '/v1/apps/crm/envs/main/db', method: 'GET' }).reply(503, '');
  const down = await cli(['app', 'db', 'info'], { cwd: dir, dispatcher: agent });
  assert.equal(down.code, 6);

  const { agent: offline } = mockApi();
  const unreachable = await cli(['app', 'services', '--json'], { cwd: dir, dispatcher: offline });
  assert.equal(unreachable.code, 6);
  const unreachableErr = JSON.parse(unreachable.stderr).error;
  assert.equal(unreachableErr.code, 'unavailable');
  assert.match(unreachableErr.next, /curl -fsS http:\/\/cp\.test\/healthz/);
});

test('app access refuses public without --yes and sets otherwise; app status renders envs', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const refused = await cli(['app', 'access', 'set', 'public', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(refused.code, 10);
  const refusal = JSON.parse(refused.stderr).error;
  assert.equal(refusal.code, 'confirmation_required');
  assert.equal(refusal.command, 'boxlite-app app access set public --json --yes');
  assert.match(refusal.destroys[0], /anyone on the internet/);

  pool.intercept({ path: '/v1/apps/crm/envs/main/access', method: 'PUT', body: JSON.stringify({ access: 'public' }) }).reply(200, { access: 'public' }, { headers: JSON_HEADERS });
  // The project's boxlite.toml gets the same level, so later plans do not report an online-only difference.
  await writeFile(join(dir, 'boxlite.toml'), 'access = "private"\n\n[app]\nname = "crm"\n');
  const ok = await cli(['app', 'access', 'set', 'public', '--yes'], { cwd: dir, dispatcher: agent });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.lines, ['access public (live now); boxlite.toml updated to match']);
  assert.match(await readFile(join(dir, 'boxlite.toml'), 'utf8'), /^access = "public"$/m);
  assert.match(ok.stderr, /^This will make crm\/main public:/);

  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(200, { name: 'crm', envs: [{ name: 'main', status: 'live', url: 'https://cp.test/crm', latest_deployment: { number: 7, status: 'live' }, spec_version: 3 }] }, { headers: JSON_HEADERS });
  const status = await cli(['app', 'status'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(status.lines, ['App crm', '  main  live  https://cp.test/crm  #7 live  spec v3', 'next: `boxlite-app app context` for services, schema, variables and recent errors']);
});

test('app vars/secrets edit boxlite.toml locally, honour --env, and never call the API', async () => {
  const dir = await project(root, { 'boxlite.toml': `# top comment\n${BASE_TOML}`, '.boxlite/link.json': linkJson(1), 'vars.env': 'A=1\nB="two words"\n' });
  const { agent } = mockApi();
  const set = await cli(['app', 'vars', 'set', 'LOG_LEVEL=info'], { cwd: dir, dispatcher: agent });
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(set.lines, ['set LOG_LEVEL=info', 'next: `boxlite-app plan`, then `boxlite-app apply --yes` (or `deploy`) to publish']);
  assert.equal(set.stderr, 'note: boxlite.toml was rewritten; its comments were dropped\n');

  const staging = await cli(['app', 'vars', 'import', 'vars.env', '--env', 'staging'], { cwd: dir, dispatcher: agent });
  assert.equal(staging.code, 0, staging.stderr);
  assert.equal(staging.stderr, '');
  const ref = await cli(['app', 'secrets', 'ref', 'OPENAI_API_KEY', 'org/openai', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(ref.code, 0);
  const bad = await cli(['app', 'vars', 'set', 'lower=1'], { cwd: dir, dispatcher: agent });
  assert.equal(bad.code, 1);

  const toml = await readFile(join(dir, 'boxlite.toml'), 'utf8');
  assert.match(toml, /\[variables\]\nLOG_LEVEL = "info"/);
  assert.match(toml, /\[secrets\]\nOPENAI_API_KEY = "org\/openai"/);
  assert.match(toml, /\[env\.staging\.variables\]\nA = "1"\nB = "two words"/);
  const dry = await cli(['app', 'vars', 'import', 'vars.env', '--dry-run'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(dry.lines, ['would set A=1', 'would set B=two words']);
});

test('app pull rewrites boxlite.toml from the spec and keeps a backup; app export prints JSON', async () => {
  const dir = await project(root, { 'boxlite.toml': `${BASE_TOML}[env.staging]\nruntime.size = "medium"\n`, '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const spec = { app: 'crm', environment: 'main', version: 5, runtime: { image: 'node', size: 'medium', build: [] }, services: [{ name: 'web', command: 'node s.js', port: true }], database: null, domains: { builtin: 'crm', custom: ['crm.acme.com'] }, access: 'org', variables: {}, secrets: {}, assigned: {} };
  pool.intercept({ path: '/v1/apps/crm/envs/main/spec', method: 'GET' }).reply(200, spec, { headers: JSON_HEADERS }).times(2);

  const pull = await cli(['app', 'pull'], { cwd: dir, dispatcher: agent });
  assert.equal(pull.code, 0, pull.stderr);
  assert.match(pull.lines[0] ?? '', /^wrote boxlite.toml from spec v5 \(previous file kept as boxlite.toml.bak/);
  const toml = await readFile(join(dir, 'boxlite.toml'), 'utf8');
  assert.match(toml, /size = "medium"/);
  assert.match(toml, /\[domains\]\ncustom = \[ "crm.acme.com" \]/);
  assert.match(await readFile(join(dir, 'boxlite.toml.bak'), 'utf8'), /\[env\.staging\]/);
  assert.equal(JSON.parse(await readFile(join(dir, '.boxlite/link.json'), 'utf8')).base_version, 5);
  const check = await cli(['check'], { cwd: dir, dispatcher: agent });
  assert.equal(check.code, 0, check.stdout);

  const exported = await cli(['app', 'export', '--json'], { cwd: dir, dispatcher: agent });
  assert.deepEqual(JSON.parse(exported.stdout), spec);
});

test('app deployment --follow prints steps; rollback posts kind=rollback; env delete confirms', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/4', method: 'GET' }).reply(200, { number: 4, kind: 'deploy', status: 'building', message: 'wip' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/4/events', method: 'GET' }).reply(
    200,
    sse([
      { event: 'step', data: { name: 'build', status: 'done', ms: 2000, detail: 'npm ci' } },
      { event: 'log', data: { source: 'web', line: 'ready' } },
      { event: 'done', data: { status: 'live', deployment: { number: 4, status: 'live', spec_version: 2, url: 'https://cp.test/crm' } } },
    ]),
    { headers: SSE_HEADERS },
  );
  const follow = await cli(['app', 'deployment', '4', '--follow', '--logs'], { cwd: dir, dispatcher: agent });
  assert.equal(follow.code, 0, follow.stderr);
  assert.deepEqual(follow.lines.slice(0, 4), ['#4  deploy · building · wip', '#4  Building    npm ci   2s', '    web | ready', '#4  Live        https://cp.test/crm · spec v2']);

  let body: Record<string, unknown> | undefined;
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments', method: 'POST', body: (b) => ((body = JSON.parse(b)), true) }).reply(202, { number: 5, kind: 'rollback', status: 'queued' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/5/events', method: 'GET' }).reply(200, sse([{ event: 'done', data: { status: 'live', deployment: { number: 5, status: 'live', spec_version: 1, url: 'https://cp.test/crm' } } }]), { headers: SSE_HEADERS });
  const rollback = await cli(['app', 'rollback', '3', '--with-database', '--yes'], { cwd: dir, dispatcher: agent });
  assert.equal(rollback.code, 0, rollback.stderr);
  assert.deepEqual(body, { kind: 'rollback', to: 3, with_database: true });
  assert.equal(rollback.lines[0], 'Rollback #5 → release of #3 started');

  const staging = { name: 'staging', status: 'live', url: 'https://cp.test/crm--staging', box: { id: 'b9' }, database: { branch: 'br-staging' } };
  pool.intercept({ path: '/v1/apps/crm/envs/staging', method: 'GET' }).reply(200, staging, { headers: JSON_HEADERS }).times(3);
  pool.intercept({ path: '/v1/apps/crm/envs/staging/spec', method: 'GET' }).reply(200, { volumes: [{ name: 'uploads', mount: '/data/uploads' }] }, { headers: JSON_HEADERS }).times(3);
  const prompted = await cli(['app', 'env', 'delete', 'staging'], { cwd: dir, dispatcher: agent, isTTY: true, stdin: 'n\n' });
  assert.equal(prompted.code, 0);
  assert.match(prompted.stdout, /cancelled/);
  assert.match(prompted.stderr, /This will delete environment staging of crm:\n  - Box b9 with its releases\n  - database branch br-staging and all of its data\n  - volume uploads \(\/data\/uploads\) and every file in it/);
  const agentRefused = await cli(['app', 'env', 'delete', 'staging', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(agentRefused.code, 10);
  assert.equal(JSON.parse(agentRefused.stderr).error.undo, 'none: this cannot be undone');
  pool.intercept({ path: '/v1/apps/crm/envs/staging', method: 'DELETE' }).reply(204, '');
  const deleted = await cli(['app', 'env', 'delete', 'staging', '--yes'], { cwd: dir, dispatcher: agent });
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.deepEqual(deleted.lines, ['environment staging deleted']);
});

test('app sql prints a table and usage errors are exit 1', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/main/db/sql', method: 'POST', body: JSON.stringify({ query: 'select 1 as n', write: false, explain: false }) }).reply(200, { columns: ['n', 'name'], rows: [[1, 'a'], [2, null]], elapsed_ms: 3, row_count: 2 }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'sql', 'select 1 as n'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.lines, ['n  name', '-  ----', '1  a', '2  NULL', '2 rows · 3 ms']);

  const usage = await cli(['app', 'deployment', 'abc'], { cwd: dir, dispatcher: agent });
  assert.equal(usage.code, 1);
  const unknown = await cli(['frobnicate', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(unknown.code, 1);
  assert.deepEqual(JSON.parse(unknown.stderr), { error: { code: 'usage', message: "unknown command 'frobnicate'", next: 'see `boxlite-app --help`' } });
  const misplaced = await cli(['logs', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(misplaced.stderr).error.next, '`logs` lives under app: `boxlite-app app logs`');
  const typo = await cli(['app', 'stat'], { cwd: dir, dispatcher: agent });
  assert.equal(typo.stderr, "error: unknown command 'stat'\n  next: did you mean `boxlite-app app status`?\n");
});

test('app env delete stops when the spec cannot be read, instead of hiding the volumes it would delete', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/staging', method: 'GET' }).reply(200, { name: 'staging', status: 'live', url: 'https://x.test' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/staging/spec', method: 'GET' }).reply(403, { error: { code: 'forbidden', message: 'nope' } }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'env', 'delete', 'staging', '--yes', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 5, res.stderr);
  assert.equal(JSON.parse(res.stderr).error.code, 'forbidden');
});

test('app clone defaults to the live code, not the newest deployment (applies carry no source)', async () => {
  const { defaultCloneSource } = await import('../src/commands/app.js');
  const deps = [
    { number: 9, kind: 'apply', status: 'live', snapshot_id: 'snap_a' },
    { number: 8, kind: 'deploy', status: 'failed', snapshot_id: 'snap_b' },
    { number: 7, kind: 'deploy', status: 'superseded', snapshot_id: 'snap_a' },
    { number: 6, kind: 'deploy', status: 'superseded', snapshot_id: 'snap_0' },
  ];
  assert.equal(defaultCloneSource({ name: 'main', live_deployment: { number: 9, release: 7 } }, deps)?.number, 7);
  assert.equal(defaultCloneSource({ name: 'main', live_deployment: null }, deps)?.number, 7);
  assert.equal(defaultCloneSource({ name: 'main' }, [deps[1]!])?.number, 8);
  assert.equal(defaultCloneSource({ name: 'main' }, [deps[0]!]), undefined);
});

test('a control-plane 500 does not suggest BOXLITE_DEBUG, which only prints client-side stacks', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(500, { error: { code: 'internal', message: 'boom' } }, { headers: JSON_HEADERS }).persist();
  const res = await cli(['app', 'status', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr).error;
  assert.equal(err.code, 'internal');
  assert.doesNotMatch(err.next, /BOXLITE_DEBUG/);
  assert.match(err.next, /boxlite-app doctor/);
});

test('a reset connection is retried for writes that are safe to repeat, with the same idempotency key', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const keys: string[] = [];
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments', method: 'POST', headers: (h) => (keys.push(String((h as Record<string, string>)['idempotency-key'])), true) }).replyWithError(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }));
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments', method: 'POST', headers: (h) => (keys.push(String((h as Record<string, string>)['idempotency-key'])), true) }).reply(202, { number: 4, kind: 'rollback', status: 'queued' }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/deployments/4/events', method: 'GET' }).reply(200, sse([{ event: 'done', data: { status: 'live', deployment: { number: 4, kind: 'rollback', status: 'live' } } }]), { headers: SSE_HEADERS });
  const res = await cli(['app', 'rollback', '2', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  const unique = [...new Set(keys)];
  assert.equal(unique.length, 1, `one idempotency key across the retry: ${keys.join(', ')}`);
});
