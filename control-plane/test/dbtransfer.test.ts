import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { PgAppDatabase, PgPools } from '../src/appdb.js';
import { csvHeader } from '../src/dbtransfer.js';
import { signConsoleSession } from '../src/console-auth.js';
import { createApp, harness, type Harness } from './helpers.js';
import { liveDb, pgConfig, skipLive, type LiveDb } from './live-pg.js';

let h: Harness;
let key: string;
before(async () => {
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

const text = async (r: Readable) => {
  let s = '';
  for await (const c of r) s += c;
  return s;
};

test('the CSV header is read without losing a byte of the body', async () => {
  const body = Readable.from([Buffer.from('ti'), Buffer.from('tle,"am""t, x"\r\nfirst,1\n'), Buffer.from('second,2\n')]);
  const { columns, stream } = await csvHeader(body);
  assert.deepEqual(columns, ['title', 'am"t, x']);
  assert.equal(await text(stream), 'title,"am""t, x"\r\nfirst,1\nsecond,2\n');
  assert.deepEqual((await csvHeader(Readable.from([Buffer.from('')]))).columns, []);
});

test('export and import validate before they touch the database', async () => {
  const app = h.ctx.store.appByName('crm')!;
  const ex = (q: string) => h.request(`/v1/apps/crm/envs/main/db/export${q}`, { key });
  assert.equal((await ex('?table=deals')).status, 404, 'no database yet');
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { db_url: 'postgresql://u:p@ep.neon.test/neondb', neon_branch_id: 'br-main' });
  const csvAll = await ex('?format=csv');
  assert.equal(csvAll.status, 400);
  assert.match(((await csvAll.json()) as any).error.next, /--table/);
  assert.equal((await ex('?format=xml')).status, 400);
  // FakeAppDb has no transfer support: the CP says so instead of failing obscurely.
  assert.equal((await ex('?format=sql')).status, 503);
  const im = await h.request('/v1/apps/crm/envs/main/db/import', { method: 'POST', key, body: 'a\n1\n' });
  assert.equal(im.status, 400);
  assert.match(((await im.json()) as any).error.message, /table/);
});

// ---- live ---------------------------------------------------------------------------------------

let db: LiveDb;
let pools: PgPools;

async function setupLive(): Promise<void> {
  db = await liveDb();
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { db_url: db.ownerUrl, neon_branch_id: 'br-main' });
  pools = new PgPools();
  const real = new PgAppDatabase(pools.acquire);
  real.bindReaders({ urlFor: async () => db.readerUrl, refresh: async () => db.readerUrl });
  for (const m of ['query', 'listApplied', 'loginUrl', 'exportCsv', 'exportSql', 'importCsv'] as const) Object.assign(h.appdb, { [m]: (real[m] as (...a: unknown[]) => unknown).bind(real) });
  const c = new pg.Client(pgConfig(db.ownerUrl));
  await c.connect();
  await c.query(`
    CREATE TYPE mood AS ENUM ('happy', 'sad');
    CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at := now(); RETURN NEW; END$$;
    CREATE TABLE accounts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE);
    CREATE TABLE deals (
      id serial PRIMARY KEY,
      account_id bigint REFERENCES accounts (id),
      title text NOT NULL CHECK (title <> ''),
      amount numeric(10, 2) DEFAULT 0,
      tags text[],
      meta jsonb,
      feeling mood,
      doubled numeric GENERATED ALWAYS AS (amount * 2) STORED,
      updated_at timestamptz
    );
    CREATE INDEX deals_title ON deals (lower(title));
    CREATE TRIGGER deals_touch BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION touch();
    ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own ON deals FOR SELECT USING (amount >= 0);
    CREATE VIEW big_deals AS SELECT id, title FROM deals WHERE amount > 100;
    INSERT INTO accounts (name) VALUES ('acme'), ('O''Brien & co');
    INSERT INTO deals (account_id, title, amount, tags, meta, feeling) VALUES
      (1, 'first', 10.5, '{a,"b c"}', '{"k": "v''q"}', 'happy'),
      (2, 'line
break', 250, NULL, NULL, NULL);
  `);
  await c.end();
}

test('live: CSV export of one table, as the reader, header first', { skip: skipLive }, async () => {
  await setupLive();
  const res = await h.request('/v1/apps/crm/envs/main/db/export?table=accounts', { key });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /crm-main-accounts\.csv/);
  assert.equal(await res.text(), 'id,name\n1,acme\n2,O\'Brien & co\n');
  assert.equal((await h.request('/v1/apps/crm/envs/main/db/export?table=nope', { key })).status, 404);
  const app = h.ctx.store.appByName('crm')!;
  const row = h.ctx.store.get<{ detail: string }>("SELECT detail FROM activity WHERE app_id = ? AND action = 'db.export' ORDER BY id DESC", app.id)!;
  assert.deepEqual(JSON.parse(row.detail), { format: 'csv', table: 'accounts' });
});

test('live: the SQL dump restores into an empty database with the same schema and data', { skip: skipLive }, async () => {
  const res = await h.request('/v1/apps/crm/envs/main/db/export?format=sql', { key });
  assert.equal(res.status, 200);
  const dump = await res.text();
  for (const part of ['CREATE TYPE public."mood"', 'CREATE TABLE public."deals"', 'GENERATED ALWAYS AS IDENTITY', 'OVERRIDING SYSTEM VALUE', 'CREATE TRIGGER deals_touch', 'CREATE POLICY "own"', 'CREATE VIEW public."big_deals"', 'COMMIT;']) {
    assert.ok(dump.includes(part), `dump has ${part}`);
  }
  // Capture, wipe, restore, compare.
  const c = new pg.Client(pgConfig(db.ownerUrl));
  await c.connect();
  try {
    const snapshot = async () => ({
      deals: (await c.query('SELECT id, account_id, title, amount::text, tags, meta, feeling::text, doubled::text FROM deals ORDER BY id')).rows,
      accounts: (await c.query('SELECT * FROM accounts ORDER BY id')).rows,
      next: (await c.query(`SELECT pg_get_serial_sequence('deals', 'id') AS s`)).rows[0].s,
    });
    const before = await snapshot();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await c.query(dump);
    assert.deepEqual(await snapshot(), before);
    // Sequences continue after the restored rows; triggers, checks and FKs are back.
    assert.equal((await c.query("INSERT INTO accounts (name) VALUES ('new') RETURNING id")).rows[0].id, '3');
    assert.equal((await c.query("INSERT INTO deals (title) VALUES ('n') RETURNING id")).rows[0].id, 3);
    await assert.rejects(c.query("INSERT INTO deals (title) VALUES ('')"), /check/);
    await assert.rejects(c.query("INSERT INTO deals (title, account_id) VALUES ('x', 99)"), /foreign key/);
    const touched = await c.query("UPDATE deals SET title = 'f2' WHERE id = 1 RETURNING updated_at");
    assert.ok(touched.rows[0].updated_at);
  } finally {
    await c.end();
  }
});

test('live: CSV import as the owner, all or nothing, snapshot and Activity first', { skip: skipLive }, async () => {
  const im = (table: string, body: string) => h.request(`/v1/apps/crm/envs/main/db/import?table=${table}`, { method: 'POST', key, body, headers: { 'content-type': 'text/csv' } });
  const ok = await im('accounts', 'name\nglobex\n"Initech, Inc"\n');
  assert.equal(ok.status, 200, await ok.clone().text());
  const out = (await ok.json()) as { rows: number; columns: string[]; snapshot: string };
  assert.equal(out.rows, 2);
  assert.deepEqual(out.columns, ['name']);
  assert.match(out.snapshot, /^dbs_/);

  const bad = await im('accounts', 'name\nunique-one\nacme\n'); // acme exists: UNIQUE fails the whole import
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as any).error.code, 'sql_error');
  const unknown = await im('accounts', 'name,colour\nx,red\n');
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as any).error.message, /colour/);
  assert.equal((await im('nope', 'a\n1\n')).status, 404);

  const r = await h.appdb.query(db.ownerUrl, ["SELECT count(*)::int FROM accounts WHERE name IN ('globex', 'Initech, Inc', 'unique-one')"], { write: false });
  assert.equal(r.rows[0]![0], 2);
  const app = h.ctx.store.appByName('crm')!;
  const act = h.ctx.store.get<{ detail: string; actor: string }>("SELECT detail, actor FROM activity WHERE app_id = ? AND action = 'db.import' ORDER BY id DESC", app.id)!;
  assert.equal(JSON.parse(act.detail).rows, 2);
  assert.match(act.actor, /^key:/);
  assert.ok(h.ctx.store.get("SELECT 1 FROM db_snapshots WHERE id = ? AND message = 'before import into accounts'", out.snapshot));
});

test('live: the console downloads the same exports (Export CSV, Download dump), as actor console', { skip: skipLive }, async () => {
  const headers = { cookie: `__Host-bxl_console=${signConsoleSession('test-session-secret')}` };
  const csv = await h.request('/console/api/apps/crm/database/export?table=accounts', { headers });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition') ?? '', /crm-main-accounts\.csv/);
  assert.match(await csv.text(), /^id,name\n1,acme\n/);
  const dump = await h.request('/console/api/apps/crm/database/export?format=sql', { headers });
  assert.equal(dump.status, 200);
  assert.match(dump.headers.get('content-type') ?? '', /application\/sql/);
  assert.match(await dump.text(), /CREATE TABLE public\."accounts"/);
  const missing = await h.request('/console/api/apps/crm/database/export?table=nope', { headers });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as any).error.code, 'not_found');
  const app = h.ctx.store.appByName('crm')!;
  const row = h.ctx.store.get<{ actor: string }>("SELECT actor FROM activity WHERE app_id = ? AND action = 'db.export' ORDER BY id DESC", app.id)!;
  assert.equal(row.actor, 'console');
});

after(async () => {
  await pools?.close();
  await db?.drop();
});
