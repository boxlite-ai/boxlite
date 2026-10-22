import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgAppDatabase, PgPools } from '../src/appdb.js';
import { READER_ROLE } from '../src/sqlguard.js';
import { backends, liveDb, skipLive, type LiveDb } from './live-pg.js';

/** The connection pool against a real Postgres (skipped without MICROCLOUD_TEST_PG_URL, see live-pg.ts). */

let db: LiveDb;
let pools: PgPools;
let appdb: PgAppDatabase;
const owner = () => decodeURIComponent(new URL(db.ownerUrl).username);

before(async () => {
  if (skipLive) return;
  db = await liveDb();
  pools = new PgPools({ idleMs: 400 });
  appdb = new PgAppDatabase(pools.acquire);
  appdb.bindReaders({ urlFor: async () => db.readerUrl, refresh: async () => db.readerUrl });
});
after(async () => {
  await pools?.close();
  await db?.drop();
});

const pid = async (write: boolean) => (await appdb.query(db.ownerUrl, ['SELECT pg_backend_pid()'], { write })).rows[0]![0] as number;

test('sequential queries reuse one connection per role; reads still log in as the reader, READ ONLY', { skip: skipLive }, async () => {
  const pids = new Set<number>();
  for (let i = 0; i < 5; i++) pids.add(await pid(false));
  assert.equal(pids.size, 1, `reads used backends ${[...pids]}`);
  const who = await appdb.query(db.ownerUrl, ['SELECT current_user, current_setting(\'transaction_read_only\')'], { write: false });
  assert.deepEqual(who.rows[0], [READER_ROLE, 'on']);
  const ownerPid = await pid(true);
  assert.ok(!pids.has(ownerPid), 'the owner never shares a connection with the reader');
  const w = await appdb.query(db.ownerUrl, ['SELECT current_user'], { write: true });
  assert.equal(w.rows[0]![0], owner());
});

test('session state a committed write leaves behind is gone for the next caller of that connection', { skip: skipLive }, async () => {
  await appdb.query(db.ownerUrl, ['CREATE TABLE IF NOT EXISTS t (a int)'], { write: true });
  const before = await pid(true);
  await appdb.query(
    db.ownerUrl,
    [
      'SET search_path TO pg_catalog',
      "SET application_name = 'leak'",
      'DECLARE held CURSOR WITH HOLD FOR SELECT 1',
      'CREATE TEMP TABLE scratch (a int)',
      'SELECT pg_advisory_lock(4242)',
      'PREPARE p AS SELECT 1',
    ],
    { write: true },
  );
  const r = await appdb.query(
    db.ownerUrl,
    [
      `SELECT pg_backend_pid(), current_setting('search_path'), current_setting('application_name'),
              (SELECT count(*) FROM pg_cursors WHERE name = 'held')::int, to_regclass('pg_temp.scratch') IS NULL,
              (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid())::int,
              (SELECT count(*) FROM pg_prepared_statements)::int`,
    ],
    { write: true },
  );
  const [samePid, searchPath, appName, cursors, noTemp, locks, prepared] = r.rows[0]!;
  assert.equal(samePid, before, 'the same pooled connection served both callers');
  assert.equal(searchPath, '"$user", public');
  assert.equal(appName, '');
  assert.equal(cursors, 0);
  assert.equal(noTemp, true);
  assert.equal(locks, 0);
  assert.equal(prepared, 0);
});

test('at most 3 connections per role, however many callers', { skip: skipLive }, async () => {
  const pids = await Promise.all(Array.from({ length: 8 }, () => appdb.query(db.ownerUrl, ['SELECT pg_backend_pid(), pg_sleep(0.1)'], { write: false })));
  assert.ok(new Set(pids.map((r) => r.rows[0]![0])).size <= 3);
  assert.ok((await backends(db, READER_ROLE)) <= 3);
});

test('a connection killed while idle in the pool is replaced transparently (one retry)', { skip: skipLive }, async () => {
  const first = await pid(false);
  // What Neon does when it suspends the compute: the server ends the idle session.
  await db.admin.query('SELECT pg_terminate_backend($1)', [first]);
  const second = await pid(false);
  assert.notEqual(second, first);
});

test('idle connections close after the idle timeout and the pool is dropped', { skip: skipLive }, async () => {
  await pid(false);
  await pid(true);
  assert.ok(pools.size >= 1);
  await sleep(2500); // idle timeout 400 ms, plus DISCARD ALL and pool shutdown over a remote link
  assert.equal(pools.size, 0, 'pools dropped');
  assert.equal(await backends(db, READER_ROLE), 0, 'reader backends');
  assert.equal(await backends(db, owner()), 0, 'owner backends');
});
