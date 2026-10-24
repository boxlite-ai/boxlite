import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { to as copyTo, from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { PgAppDatabase, PgPools } from '../src/appdb.js';
import { handleDbConnect } from '../src/dbproxy/index.js';
import { proxyRefusal } from '../src/sqlguard.js';
import { API_PORT, createApp, harness, type Harness } from './helpers.js';
import { liveDb, pgConfig, skipLive, type LiveDb } from './live-pg.js';

// ---- the policy (no database needed) -------------------------------------------------------

test('proxy policy: a reader session may read and drive its own transactions, nothing else', () => {
  const reader = { write: false, main: true };
  for (const sql of [
    'SELECT 1',
    'BEGIN',
    'BEGIN ISOLATION LEVEL REPEATABLE READ',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT a',
    'PREPARE p AS SELECT $1::int',
    'EXECUTE p(1)',
    'DEALLOCATE ALL',
    'DISCARD ALL',
    "SET statement_timeout = '1min'",
    'SET search_path TO public',
    'COPY deals TO STDOUT WITH (FORMAT csv)',
    'COPY (SELECT 1) TO STDOUT',
    'SHOW server_version',
    'RESET ALL',
    'SET TRANSACTION READ ONLY',
  ]) {
    assert.equal(proxyRefusal(sql, reader), null, sql);
  }
  for (const [sql, why] of [
    ["INSERT INTO deals VALUES (1)", /read-only/],
    ['BEGIN READ WRITE', /read-only/],
    ['START TRANSACTION READ WRITE', /read-only/],
    ['SET TRANSACTION READ WRITE', /read-only/],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', /read-only/],
    ['SET transaction_read_only = off', /read-only/],
    ['SET default_transaction_read_only = off', /not allowed/],
    ['SET ROLE neondb_owner', /not allowed/],
    ["SELECT set_config('role', 'neondb_owner', false)", /set_config/],
    ['SELECT pg_terminate_backend(1)', /pg_terminate_backend/],
    ["COPY deals FROM '/etc/passwd'", /server file/],
    ["COPY deals TO PROGRAM 'id'", /server file or program/],
    ['COPY deals FROM STDIN', /read-only/],
    ['PREPARE w AS DELETE FROM deals', /read-only/],
    ['CREATE ROLE x LOGIN', /roles are managed/],
    ['ALTER SYSTEM SET work_mem = 1', /not allowed/],
    ['WITH d AS (DELETE FROM deals RETURNING *) SELECT * FROM d', /read-only/],
  ] as const) {
    const no = proxyRefusal(sql, reader);
    assert.ok(no, `${sql} should be refused`);
    assert.match(no.message, why, sql);
  }
});

test('proxy policy: the owner writes data anywhere, changes the schema only off main', () => {
  const main = { write: true, main: true };
  const dev = { write: true, main: false };
  for (const sql of ['INSERT INTO deals VALUES (1)', 'COPY deals FROM STDIN WITH (FORMAT csv)', 'BEGIN READ WRITE', 'UPDATE deals SET a = 1', 'DELETE FROM deals']) {
    assert.equal(proxyRefusal(sql, main), null, sql);
  }
  for (const sql of ['CREATE TABLE x (a int)', 'ALTER TABLE deals ADD COLUMN b int', 'DROP TABLE deals', 'TRUNCATE deals', 'DO $$BEGIN END$$', 'CREATE INDEX ON deals (a)']) {
    assert.match(proxyRefusal(sql, main)?.message ?? '', /not allowed on main/, sql);
    assert.equal(proxyRefusal(sql, dev), null, `${sql} on dev`);
  }
  // Never, for anyone.
  assert.ok(proxyRefusal("SELECT lo_import('/etc/passwd')", dev));
  assert.ok(proxyRefusal('CREATE EXTENSION dblink', dev));
  assert.equal(proxyRefusal('SELEC 1', main), null, 'a syntax error is the database’s to report');
  assert.equal(proxyRefusal('', main), null);
});

// ---- the upgrade: who may connect -------------------------------------------------------------

let h: Harness;
let key: string;
let server: Server;
let port: number;

before(async () => {
  h = harness();
  key = await createApp(h);
  await createApp(h, 'other');
  server = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await new Promise((r) => setTimeout(r, 50));
  // As if this socket were the API origin's listener (main.ts dispatches upgrades the same way).
  server.on('upgrade', (req, socket, head) => {
    const handled = handleDbConnect(h.ctx, req, socket, head, API_PORT);
    if (!handled) socket.destroy();
  });
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  h?.close();
});

function upgrade(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = netConnect(port, '127.0.0.1', () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('')}\r\n`,
      );
    });
    let text = '';
    s.on('data', (d) => {
      text += d;
      if (text.includes('\r\n\r\n')) {
        const status = Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1]);
        if (status === 101 || /\r\n\r\n[\s\S]*\}$/.test(text)) {
          s.destroy();
          resolve({ status, body: text.split('\r\n\r\n')[1] ?? '' });
        }
      }
    });
    s.on('error', reject);
  });
}

test('db/connect needs the App key of that App, an existing env with a database', async () => {
  const path = '/v1/apps/crm/envs/main/db/connect';
  assert.equal((await upgrade(path)).status, 401);
  assert.equal((await upgrade(path, { authorization: 'Bearer bxl_app_nope' })).status, 401);
  const otherKey = (await upgrade('/v1/apps/other/envs/main/db/connect', { authorization: `Bearer ${key}` })).status;
  assert.equal(otherKey, 403);
  assert.equal((await upgrade('/v1/apps/crm/envs/nope/db/connect', { authorization: `Bearer ${key}` })).status, 404);
  const noDb = await upgrade(path, { authorization: `Bearer ${key}` });
  assert.equal(noDb.status, 404);
  assert.match(noDb.body, /has no database/);
});

test('db/connect is only on the API origin; other upgrades are left to the app-origin proxy', () => {
  const req = { url: '/v1/apps/crm/envs/main/db/connect', headers: {} } as never;
  assert.equal(handleDbConnect(h.ctx, req, null as never, Buffer.alloc(0), h.appPort()), null);
  assert.equal(handleDbConnect(h.ctx, { url: '/ws', headers: {} } as never, null as never, Buffer.alloc(0), API_PORT), null);
});

// ---- live: psql / node-pg → CLI bridge → CP → Postgres -----------------------------------------

let db: LiveDb;
let pools: PgPools;

/**
 * The local end, as the CLI's `db proxy` does it (cli/src/dbproxy.ts, tested in the CLI package):
 * a 127.0.0.1 port whose every connection rides its own WebSocket to db/connect.
 */
interface Bridge {
  port: number;
  close(): Promise<void>;
}
const bridges: Bridge[] = [];

function startBridge(url: string, headers: Record<string, string>): Promise<Bridge> {
  const socks = new Set<import('node:net').Socket>();
  const srv = createNetServer((sock) => {
    socks.add(sock);
    const ws = new WebSocket(url, { headers } as never);
    ws.binaryType = 'arraybuffer';
    const pending: Buffer[] = [];
    let open = false;
    let ended = false;
    ws.onopen = () => {
      open = true;
      for (const b of pending.splice(0)) ws.send(b);
      if (ended) ws.close();
    };
    ws.onmessage = (ev) => sock.write(Buffer.from(ev.data as ArrayBuffer));
    ws.onerror = () => sock.destroy();
    ws.onclose = () => sock.end();
    sock.on('data', (d) => (open ? ws.send(d) : pending.push(d)));
    sock.on('close', () => {
      socks.delete(sock);
      // A cancel request is written and closed at once: send it before closing.
      if (open) ws.close();
      else ended = true;
    });
    sock.on('error', () => ws.close());
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: (srv.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of socks) s.destroy();
            srv.close(() => r());
          }),
      }),
    ),
  );
}

let live: Promise<void> | undefined;
const setupLive = () => (live ??= doSetupLive());
async function doSetupLive(): Promise<void> {
  db = await liveDb();
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { db_url: db.ownerUrl, neon_branch_id: 'br-main' });
  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'dev')!.id, { db_url: db.ownerUrl, neon_branch_id: 'br-dev' });
  // The real database behind the routes, readers included (FakeAppDb otherwise).
  pools = new PgPools();
  const real = new PgAppDatabase(pools.acquire);
  real.bindReaders({ urlFor: async () => db.readerUrl, refresh: async () => db.readerUrl });
  for (const m of ['query', 'listApplied', 'loginUrl', 'exportCsv', 'exportSql', 'importCsv'] as const) Object.assign(h.appdb, { [m]: (real[m] as (...a: unknown[]) => unknown).bind(real) });
  const owner = new pg.Client(pgConfig(db.ownerUrl));
  await owner.connect();
  await owner.query('CREATE TABLE deals (id serial PRIMARY KEY, title text NOT NULL, amount int)');
  await owner.query("INSERT INTO deals (title, amount) VALUES ('first', 10), ('second', 20)");
  await owner.end();
}

async function bridge(env: string, write: boolean, apiKey = key): Promise<number> {
  const b = await startBridge(`ws://127.0.0.1:${port}/v1/apps/crm/envs/${env}/db/connect${write ? '?write=1' : ''}`, {
    authorization: `Bearer ${apiKey}`,
    'x-boxlite-proxy-session': `test-${env}-${write ? 'w' : 'r'}-session`,
  });
  bridges.push(b);
  return b.port;
}

async function client(localPort: number): Promise<pg.Client> {
  // Any user and password: the App key on the WebSocket is the authentication.
  const c = new pg.Client({ host: '127.0.0.1', port: localPort, user: 'anyone', password: 'ignored', database: 'whatever' });
  await c.connect();
  return c;
}

const sqlError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string; hint?: string };
  }
  assert.fail('expected an error');
};

test('live: reader by default; refused statements answer as Postgres errors and the session goes on', { skip: skipLive }, async () => {
  await setupLive();
  const c = await client(await bridge('main', false));
  try {
    assert.equal((await c.query('SELECT current_user AS u')).rows[0].u, 'boxlite_reader');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM deals')).rows[0].n, 2);
    assert.equal((await c.query('SELECT title FROM deals WHERE amount = $1', [20])).rows[0].title, 'second');

    const ins = await sqlError(c.query("INSERT INTO deals (title) VALUES ('x')"));
    assert.equal(ins.code, '42501');
    assert.match(ins.message, /BoxLite: INSERT would change data, and this connection is read-only/);
    assert.match(ins.hint ?? '', /db proxy --write/);
    // Extended protocol with parameters: the refusal keeps the client's Bind working.
    const param = await sqlError(c.query('INSERT INTO deals (title, amount) VALUES ($1, $2)', ['x', 1]));
    assert.match(param.message, /read-only/);
    assert.match((await sqlError(c.query('BEGIN READ WRITE'))).message, /read-only/);
    assert.match((await sqlError(c.query('SET ROLE NONE'))).message, /not allowed/);
    assert.match((await sqlError(c.query('SELECT pg_terminate_backend(pg_backend_pid())'))).message, /pg_terminate_backend/);

    await c.query('BEGIN');
    assert.equal((await c.query('SELECT 1 AS one')).rows[0].one, 1);
    await c.query('COMMIT');
    // Even past the guard, Postgres itself keeps the reader read-only.
    assert.equal((await c.query(`SELECT current_setting('default_transaction_read_only') AS ro`)).rows[0].ro, 'on');
    const csv: Buffer[] = [];
    await pipeline(c.query(copyTo('COPY deals (title) TO STDOUT WITH (FORMAT csv)')), async function* (src) {
      for await (const chunk of src) csv.push(chunk as Buffer);
    });
    assert.equal(Buffer.concat(csv).toString(), 'first\nsecond\n');
  } finally {
    await c.end();
  }
});

test('live: --write logs in as the owner; data changes work on main, DDL does not', { skip: skipLive }, async () => {
  await setupLive();
  const c = await client(await bridge('main', true));
  try {
    assert.notEqual((await c.query('SELECT current_user AS u')).rows[0].u, 'boxlite_reader');
    await c.query("INSERT INTO deals (title, amount) VALUES ('third', 30)");
    await pipeline(Readable.from(['title,amount\n', 'fourth,40\n']), c.query(copyFrom('COPY deals (title, amount) FROM STDIN WITH (FORMAT csv, HEADER)')));
    assert.equal((await c.query('SELECT count(*)::int AS n FROM deals')).rows[0].n, 4);
    const ddl = await sqlError(c.query('ALTER TABLE deals ADD COLUMN stage text'));
    assert.match(ddl.message, /schema changes \(DDL: ALTER\) are not allowed on main/);
    assert.match(ddl.hint ?? '', /migration new/);
    assert.match((await sqlError(c.query('DO $$BEGIN EXECUTE $q$DROP TABLE deals$q$; END$$'))).message, /not allowed on main/);
    // In a transaction the refusal aborts it, as any error would.
    await c.query('BEGIN');
    await sqlError(c.query('CREATE TABLE t2 (a int)'));
    assert.match((await sqlError(c.query('SELECT 1'))).message, /current transaction is aborted/);
    await c.query('ROLLBACK');
    await c.query("DELETE FROM deals WHERE title IN ('third', 'fourth')");
  } finally {
    await c.end();
  }
  const dev = await client(await bridge('dev', true));
  try {
    await dev.query('CREATE TABLE scratch (a int)');
    await dev.query('DROP TABLE scratch');
  } finally {
    await dev.end();
  }
});

test('live: a cancel request reaches the database through the proxy', { skip: skipLive }, async () => {
  await setupLive();
  const localPort = await bridge('main', false);
  const c = await client(localPort);
  try {
    // CPU only (no temp files): a cross join that takes minutes.
    const slow = c.query('SELECT count(*) FROM pg_class a, pg_class b, pg_class c, pg_class d');
    await sleep(300);
    const k = c as unknown as { processID: number; secretKey: number };
    const cancel = Buffer.alloc(16);
    cancel.writeInt32BE(16, 0);
    cancel.writeInt32BE(80877102, 4);
    cancel.writeInt32BE(k.processID, 8);
    cancel.writeInt32BE(k.secretKey, 12);
    await new Promise<void>((r) => netConnect(localPort, '127.0.0.1', function (this: import('node:net').Socket) {
      this.end(cancel, r);
    }));
    const err = await sqlError(slow);
    assert.equal(err.code, '57014', err.message);
  } finally {
    await c.end();
  }
});

test('live: a bad App key gets a clear error at login, not a hang', { skip: skipLive }, async () => {
  const localPort = await bridge('main', false, 'bxl_app_' + 'z'.repeat(32));
  const err = await sqlError(client(localPort));
  assert.match(err.message, /Connection terminated|ECONNRESET/);
});

const PSQL = process.env.PSQL ?? ['/opt/homebrew/opt/libpq/bin/psql', '/usr/bin/psql', '/usr/local/bin/psql'].find((p) => existsSync(p));

test('live: psql through the proxy', { skip: skipLive || (!PSQL && 'psql not found (set PSQL)') }, async () => {
  await setupLive();
  const localPort = await bridge('main', false);
  const url = `postgresql://boxlite@127.0.0.1:${localPort}/whatever?sslmode=disable`;
  // The CP runs in this process, so psql must not block it (no execFileSync).
  const runAsync = (sql: string) =>
    new Promise<string>((resolve) => execFile(PSQL!, [url, '-X', '-A', '-t', '-c', sql], { encoding: 'utf8' }, (_err, stdout, stderr) => resolve(stdout + stderr)));
  assert.equal((await runAsync('select current_user')).trim(), 'boxlite_reader');
  assert.match(await runAsync("delete from deals"), /ERROR: {2}BoxLite: DELETE would change data, and this connection is read-only/);
});

test('live: every proxy run is one Activity row with who, role, when and how long', { skip: skipLive }, async () => {
  for (const b of bridges.splice(0)) await b.close();
  await sleep(200);
  const app = h.ctx.store.appByName('crm')!;
  const rows = h.ctx.store.all<{ actor: string; env: string; detail: string }>("SELECT actor, env, detail FROM activity WHERE app_id = ? AND action = 'db.proxy' ORDER BY id", app.id);
  assert.equal(rows.length, 3, 'main reader, main owner, dev owner: one row per proxy run, not per connection');
  const details = rows.map((r) => ({ ...r, d: JSON.parse(r.detail) as Record<string, unknown> }));
  for (const r of details) {
    assert.match(r.actor, /^key:…/);
    assert.ok(['reader', 'owner'].includes(r.d.role as string));
    assert.equal(r.d.open, 0);
    assert.equal(typeof r.d.duration_ms, 'number');
    assert.ok(r.d.started_at && r.d.ended_at);
  }
  const reader = details.find((r) => r.env === 'main' && r.d.role === 'reader')!;
  assert.ok((reader.d.refused as number) >= 4, `refused ${reader.d.refused}`);
});

after(async () => {
  for (const b of bridges) await b.close();
  await pools?.close();
  await db?.drop();
});


