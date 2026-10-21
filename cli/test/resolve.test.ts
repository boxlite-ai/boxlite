import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { clearResolvedApps } from '../src/context.js';
import { API, cleanup, cli, JSON_HEADERS, KEY, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));
beforeEach(() => clearResolvedApps());

test('an unlinked directory with a valid key works: the App comes from GET /v1/apps/me, once per process', async () => {
  const dir = await project(root, {});
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me', method: 'GET' }).reply(200, { name: 'crm', envs: [] }, { headers: JSON_HEADERS });
  pool.intercept({ path: '/v1/apps/crm/envs/main/services', method: 'GET' }).reply(200, [{ name: 'web', state: 'running', health: 'healthy', restarts: 0 }], { headers: JSON_HEADERS }).times(2);
  const first = await cli(['app', 'services', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), [{ name: 'web', state: 'running', health: 'healthy', restarts: 0 }]);
  // The second run reuses the resolved name: no second /me interceptor exists.
  const second = await cli(['app', 'services', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(second.code, 0, second.stderr);
  agent.assertNoPendingInterceptors();
});

test('an unlinked directory with a bad key fails as unauthenticated (exit 2) with a next step, not not_linked', async () => {
  const dir = await project(root, {});
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/me', method: 'GET' }).reply(401, { error: { code: 'unauthenticated', message: 'App key not recognised', next: 'check BOXLITE_API_KEY against the App prompt (the key is shown once, when the App is created); `boxlite-app whoami` tests it' } }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'status', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_KEY: 'bxl_app_wrongwrongwrongwrongwrong2345', BOXLITE_API_URL: API } });
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr).error;
  assert.equal(err.code, 'unauthenticated');
  assert.equal(err.next, 'check BOXLITE_API_KEY against the App prompt (the key is shown once, when the App is created); `boxlite-app whoami` tests it');
  assert.doesNotMatch(res.stderr, /wrongwrong/);

  const noKey = await cli(['app', 'status'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_URL: API } });
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /next: export BOXLITE_API_KEY=bxl_app_… with the App key from the App prompt, then `boxlite-app whoami`|next: export BOXLITE_API_KEY=bxl_app_… \(the App key from the App prompt\), then `boxlite-app whoami`/);
});

test('BOXLITE_APP still wins over the key lookup', async () => {
  const dir = await project(root, {});
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm/envs/main/services', method: 'GET' }).reply(200, [], { headers: JSON_HEADERS });
  const res = await cli(['app', 'services', '--json'], { cwd: dir, dispatcher: agent, env: { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: API, BOXLITE_APP: 'crm' } });
  assert.equal(res.code, 0, res.stderr);
  agent.assertNoPendingInterceptors();
});
