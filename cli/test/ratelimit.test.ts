import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanup, cli, JSON_HEADERS, linkJson, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const STATUS = { name: 'crm', envs: [{ name: 'main', status: 'live', spec_version: 1 }] };
const LIMITED = { error: { code: 'rate_limited', message: 'too many requests', next: 'wait and retry', retry_after: 0 } };

test('a 429 waits Retry-After and retries, for writes too', async () => {
  const { agent, pool } = mockApi();
  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(429, LIMITED, { headers: { ...JSON_HEADERS, 'retry-after': '0' } });
  pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(200, STATUS, { headers: JSON_HEADERS });
  const dir = await project(root, { '.boxlite/link.json': linkJson() });
  const r = await cli(['app', 'status', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).name, 'crm');
});

test('after three 429s the CLI exits 6 with rate_limited', async () => {
  const { agent, pool } = mockApi();
  for (let i = 0; i < 4; i++) pool.intercept({ path: '/v1/apps/crm', method: 'GET' }).reply(429, LIMITED, { headers: { ...JSON_HEADERS, 'retry-after': '0' } });
  const dir = await project(root, { '.boxlite/link.json': linkJson() });
  const r = await cli(['app', 'status', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(r.code, 6);
  assert.equal(JSON.parse(r.stderr).error.code, 'rate_limited');
});
