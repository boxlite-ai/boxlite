import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { TOML, createApp, harness, upload, type Harness } from './helpers.js';

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { db_url: 'postgresql://u:p@ep.neon.test/neondb?sslmode=require', neon_branch_id: 'br-main' });
});
after(() => h.close());

const sql = (env: string, json: unknown) => h.request(`/v1/apps/crm/envs/${env}/db/sql`, { method: 'POST', key, json });

test('queries are read-only unless write:true', async () => {
  const res = await sql('main', { query: 'SELECT 1; SELECT 2' });
  assert.equal(res.status, 200);
  assert.deepEqual(h.appdb.queries.at(-1), { statements: ['SELECT 1', 'SELECT 2'], write: false });
  await sql('main', { query: 'UPDATE t SET a = 1', write: true });
  assert.equal(h.appdb.queries.at(-1)!.write, true);
});

test('a write without write:true is refused before it runs, with the exact fix', async () => {
  const ran = h.appdb.queries.length;
  const res = await sql('main', { query: "DELETE FROM contact_submissions WHERE name = 'test'" });
  assert.equal(res.status, 403);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, 'write_requires_flag');
  assert.match(body.error.message, /DELETE changes data/);
  assert.match(body.error.next, /--write/);
  assert.equal(h.appdb.queries.length, ran, 'nothing reached the database');
});

test('DDL on main is forbidden and points at migrations', async () => {
  const res = await sql('main', { query: '-- add a column\nALTER TABLE deals ADD COLUMN x int', write: true });
  assert.equal(res.status, 403);
  const body = (await res.json()) as any;
  assert.equal(body.error.code, 'forbidden');
  assert.match(body.error.next, /migrations\//);
});

test('DDL on another env needs write:true', async () => {
  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'dev')!.id, { db_url: 'postgresql://u:p@ep.neon.test/neondb' });
  assert.equal((await sql('dev', { query: 'CREATE TABLE x (id int)' })).status, 403);
  assert.equal((await sql('dev', { query: 'CREATE TABLE x (id int)', write: true })).status, 200);
});

test('transaction control is refused; explain wraps one statement', async () => {
  assert.equal((await sql('main', { query: 'SELECT 1; COMMIT' })).status, 403);
  await sql('main', { query: 'SELECT * FROM deals', explain: true });
  assert.deepEqual(h.appdb.queries.at(-1)!.statements, ['EXPLAIN (FORMAT TEXT) SELECT * FROM deals']);
});

test('volumes are created per env and mounted by name', async () => {
  const toml = TOML + '\n[[volume]]\nname = "uploads"\nmount = "/data/uploads"\n';
  const manifest = parseManifest(toml, 'main');
  assert.deepEqual(manifest.errors, []);
  const snapshot = await upload(h, key, { 'boxlite.toml': toml, 'package.json': '{}', 'package-lock.json': '{}', 'server.js': '' });
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifest.manifest, base_version: 0, migrations: [] } });
  assert.equal(res.status, 202, await res.clone().text());
  const env = h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
  await h.ctx.orchestrator.idle(env.id);
  assert.deepEqual(h.boxlite.volumes.map((v) => v.name), ['mc-crm-main-uploads']);
  const box = [...h.boxlite.boxes.values()][0]!;
  assert.deepEqual(box.req.volumes, [{ managed_volume: 'mc-crm-main-uploads', guest_path: '/data/uploads' }]);
});

// ---- F5: side effects through the SQL endpoint ----------------------------------------------

const devEnv = async () => {
  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'dev')!.id, { db_url: 'postgresql://u:p@ep.neon.test/neondb' });
};

test('DO and CALL are DDL-class: refused on main, need write:true elsewhere', async () => {
  for (const query of ['DO $$ BEGIN END $$', 'CALL refresh_stats()']) {
    const main = await sql('main', { query, write: true });
    assert.equal(main.status, 403, query);
    assert.match(((await main.json()) as any).error.next, /migrations\//);
  }
  await devEnv();
  assert.equal((await sql('dev', { query: 'DO $$ BEGIN END $$' })).status, 403);
  assert.equal((await sql('dev', { query: 'DO $$ BEGIN END $$', write: true })).status, 200);
});

test('side-effecting functions are refused before reaching the database, with or without write', async () => {
  const before = h.appdb.queries.length;
  for (const query of ['SELECT pg_terminate_backend(pid) FROM pg_stat_activity', 'SELECT pg_sleep(14)', "SELECT lo_import('/etc/passwd')", "SELECT set_config('role', 'neondb_owner', true)", 'RESET ROLE', "COPY t TO PROGRAM 'id'"]) {
    for (const write of [false, true]) {
      const res = await sql('main', { query, write });
      assert.equal(res.status, 403, `${query} write=${write}`);
      assert.equal(((await res.json()) as any).error.code, 'forbidden');
    }
  }
  assert.equal(h.appdb.queries.length, before);
});

test('CREATE EXTENSION and ALTER SYSTEM are refused even on a non-main env with write', async () => {
  await devEnv();
  for (const query of ['CREATE EXTENSION dblink', "ALTER SYSTEM SET work_mem = '1GB'"]) {
    const res = await sql('dev', { query, write: true });
    assert.equal(res.status, 403, query);
  }
});

test('a query that does not parse is a sql_error with a position, like Postgres', async () => {
  const res = await sql('main', { query: 'SELECT * FRM t' });
  assert.equal(res.status, 400);
  const err = ((await res.json()) as any).error;
  assert.equal(err.code, 'sql_error');
  assert.equal(err.sqlstate, '42601');
  assert.equal(err.position, 10);
});

test('the table browser where cannot add statements or call denied functions', async () => {
  const rows = (where: string) => h.request(`/v1/apps/crm/envs/main/db/rows/deals?where=${encodeURIComponent(where)}`, { key });
  // FakeAppDb answers the existence check with one row, so the table "exists".
  assert.equal((await rows('id = 1; DROP TABLE deals')).status, 400);
  assert.equal((await rows('pg_sleep(14) IS NULL')).status, 403);
  assert.equal((await rows("id IN (SELECT 1 FROM (SELECT set_config('role', 'x', true)) s)")).status, 403);
  assert.equal((await rows('id = 1 ) UNION ( SELECT 1')).status, 400);
  const ok = await rows("title ILIKE '%a%'");
  assert.equal(ok.status, 200);
  assert.match(h.appdb.queries.at(-1)!.statements[0]!, /^SELECT \* FROM public\."deals" WHERE title ILIKE '%a%' LIMIT \$1 OFFSET \$2$/);
  assert.equal(h.appdb.queries.at(-1)!.write, false);
});
