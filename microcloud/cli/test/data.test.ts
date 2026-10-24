import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BASE_TOML, cleanup, cli, JSON_HEADERS, linkJson, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const E = '/v1/apps/crm/envs/main';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const RESULT = { columns: ['n'], rows: [[1]], row_count: 1, elapsed_ms: 2, truncated: false };

test('app sql reads the query from --file or from stdin with "-"', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'q.sql': 'select count(*) as n from deals;\n' });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/db/sql`, method: 'POST', body: JSON.stringify({ query: 'select count(*) as n from deals;\n', write: false, explain: false }) }).reply(200, RESULT, { headers: JSON_HEADERS }).times(2);
  const file = await cli(['app', 'sql', '--file', 'q.sql', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(file.code, 0, file.stderr);
  assert.deepEqual(JSON.parse(file.stdout), RESULT);
  const stdin = await cli(['app', 'sql', '-'], { cwd: dir, dispatcher: agent, stdin: 'select count(*) as n from deals;\n' });
  assert.equal(stdin.code, 0, stdin.stderr);
  assert.deepEqual(stdin.lines, ['n', '-', '1', '1 row · 2 ms']);
  const none = await cli(['app', 'sql', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(none.code, 1);
  assert.match(JSON.parse(none.stderr).error.next, /--file q\.sql/);
  const both = await cli(['app', 'sql', 'select 1', '--file', 'q.sql', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(JSON.parse(both.stderr).error.code, 'usage');
});

test('app db rows renders a table with long values cut', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  const long = 'x'.repeat(100);
  pool.intercept({ path: `${E}/db/rows/deals?limit=50`, method: 'GET' }).reply(200, { columns: ['id', 'title', 'meta'], rows: [[1, long, { a: 1 }]], row_count: 1, elapsed_ms: 1, truncated: false, limit: 50, offset: 0 }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'db', 'rows', 'deals'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.lines[2], `1   ${'x'.repeat(59)}…  {"a":1}`);
});

test('db migrations and db diff compare local files with what the database applied', async () => {
  const init = 'create table deals (id int);';
  const dir = await project(root, {
    '.boxlite/link.json': linkJson(1),
    'boxlite.toml': `${BASE_TOML}[database]\n`,
    'migrations/0001_init.sql': init,
    'migrations/0002_more.sql': 'alter table deals add column x int;',
  });
  const { agent, pool } = mockApi();
  const applied = [
    { file: '0001_init.sql', sha256: sha(init), deployment: 2, applied_at: '2026-10-21T10:00:00Z' },
    { file: '0000_legacy.sql', sha256: sha('x'), deployment: 1, applied_at: '2026-10-20T10:00:00Z' },
  ];
  pool.intercept({ path: `${E}/db/applied`, method: 'GET' }).reply(200, applied, { headers: JSON_HEADERS }).times(2);
  const list = await cli(['app', 'db', 'migrations', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).map((m: { file: string; status: string }) => [m.file, m.status]), [
    ['0000_legacy.sql', 'missing_locally'],
    ['0001_init.sql', 'applied'],
    ['0002_more.sql', 'pending'],
  ]);
  const diff = await cli(['app', 'db', 'diff'], { cwd: dir, dispatcher: agent });
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.lines.at(-1) ?? '', /^next: the database has 0000_legacy\.sql but migrations\/ does not/);

  pool.intercept({ path: `${E}/db/applied`, method: 'GET' }).reply(200, [{ ...applied[0]!, sha256: sha('edited') }], { headers: JSON_HEADERS });
  const changed = await cli(['app', 'db', 'diff', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(changed.code, 7);
  const err = JSON.parse(changed.stderr).error;
  assert.equal(err.code, 'invalid_manifest');
  assert.deepEqual(err.errors.map((e: { rule: string; file: string }) => [e.rule, e.file]), [['migration_changed', 'migrations/0001_init.sql']]);
  assert.match(err.next, /db migration new/);
});

test('db migration new creates the next numbered file and never overwrites', async () => {
  const dir = await project(root, { 'boxlite.toml': `${BASE_TOML}[database]\n`, 'migrations/0007_x.sql': '' });
  const res = await cli(['app', 'db', 'migration', 'new', 'Add Deals', '--json'], { cwd: dir, env: {} });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).file, 'migrations/0008_add_deals.sql');
  assert.deepEqual((await readdir(join(dir, 'migrations'))).sort(), ['0007_x.sql', '0008_add_deals.sql']);
});
