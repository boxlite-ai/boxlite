import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESULT_BYTES, MAX_ROWS, PgAppDatabase, READER_SETUP_SQL, type DbConn, type DbCursor } from '../src/appdb.js';
import { READER_ROLE } from '../src/sqlguard.js';

/**
 * A fake Postgres connection with just enough semantics to check how PgAppDatabase uses roles and
 * transactions: whether the reader role exists, which role statements run as, READ ONLY, and
 * how many rows a result hands out.
 */
class FakePg {
  readerExists = false;
  log: string[] = [];
  /** Rows handed out by cursors, across all statements. */
  handed = 0;
  /** Statement text → rows it returns (or a function that runs it). */
  tables = new Map<string, () => unknown[][]>();

  connect = async (_url: string): Promise<DbConn> => {
    let role = 'neondb_owner';
    let readOnly = false;
    let inTx = false;
    const q = async (text: string, values?: unknown[]) => {
      this.log.push(values?.length ? `${text} ${JSON.stringify(values)}` : text);
      if (text === 'BEGIN' || text === 'BEGIN TRANSACTION READ ONLY') {
        inTx = true;
        readOnly = text !== 'BEGIN';
      } else if (text === 'COMMIT' || text === 'ROLLBACK') {
        inTx = false;
        role = 'neondb_owner';
      } else if (text === `SET LOCAL ROLE ${READER_ROLE}`) {
        if (!this.readerExists) throw Object.assign(new Error(`role "${READER_ROLE}" does not exist`), { code: '22023' }); // what Postgres 17 answers
        role = READER_ROLE;
      } else if (text === READER_SETUP_SQL) {
        assert.ok(inTx && !readOnly && role === 'neondb_owner', 'reader setup runs as the owner in a write transaction');
        this.readerExists = true;
      } else if (text === 'SELECT current_user AS u') return { rows: [{ u: role }] };
      return { rows: [] };
    };
    const self = this;
    return {
      query: q,
      cursor(text: string, values: unknown[]): DbCursor {
        self.log.push(`cursor(${role}${readOnly ? ',ro' : ''}) ${text}${values.length ? ` ${JSON.stringify(values)}` : ''}`);
        if (text === 'ESCALATE') role = 'neondb_owner'; // a statement that got back to the owner
        const gen = self.tables.get(text);
        const all = gen ? gen() : [];
        let at = 0;
        return {
          async read(n: number) {
            const batch = all.slice(at, at + n);
            at += batch.length;
            self.handed += batch.length;
            return batch;
          },
          fields: () => (gen ? ['v'] : []),
          rowCount: () => (gen ? null : 3),
          async close() {},
        };
      },
      async end() {},
    };
  };
}

const URL = 'postgresql://neondb_owner:pw@ep.neon.test/neondb';

test('reads run as boxlite_reader inside a READ ONLY transaction with timeouts, and roll back', async () => {
  const pg = new FakePg();
  pg.readerExists = true;
  pg.tables.set('SELECT 1', () => [[1]]);
  const res = await new PgAppDatabase(pg.connect).query(URL, ['SELECT 1'], { write: false });
  assert.deepEqual(res.rows, [[1]]);
  assert.deepEqual(pg.log, [
    'BEGIN TRANSACTION READ ONLY',
    `SET LOCAL ROLE ${READER_ROLE}`,
    `SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true) ["15s","20s"]`,
    `cursor(${READER_ROLE},ro) SELECT 1`,
    'SELECT current_user AS u',
    'ROLLBACK',
  ]);
});

test('writes run as the owner and commit; no role change', async () => {
  const pg = new FakePg();
  const res = await new PgAppDatabase(pg.connect).query(URL, ['UPDATE t SET a = 1'], { write: true });
  assert.equal(res.row_count, 3);
  assert.deepEqual(pg.log, [
    'BEGIN',
    `SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true) ["15s","20s"]`,
    'cursor(neondb_owner) UPDATE t SET a = 1',
    'COMMIT',
  ]);
  assert.equal(pg.readerExists, false, 'a write never needs the reader');
});

test('the reader role is created lazily on first read, then reused', async () => {
  const pg = new FakePg();
  pg.tables.set('SELECT 1', () => [[1]]);
  const db = new PgAppDatabase(pg.connect);
  await db.query(URL, ['SELECT 1'], { write: false });
  assert.equal(pg.readerExists, true);
  assert.deepEqual(pg.log.slice(0, 7), ['BEGIN TRANSACTION READ ONLY', `SET LOCAL ROLE ${READER_ROLE}`, 'ROLLBACK', 'BEGIN', READER_SETUP_SQL, 'COMMIT', 'BEGIN TRANSACTION READ ONLY']);
  pg.log = [];
  await db.query(URL, ['SELECT 1'], { write: false });
  assert.ok(!pg.log.includes(READER_SETUP_SQL));
});

test('ensureReader (migrate step) creates the role as the owner', async () => {
  const pg = new FakePg();
  await new PgAppDatabase(pg.connect).ensureReader(URL);
  assert.equal(pg.readerExists, true);
  assert.deepEqual(pg.log, ['BEGIN', READER_SETUP_SQL, 'COMMIT']);
});

test('a read that ends up as another role is discarded and rolled back', async () => {
  const pg = new FakePg();
  pg.readerExists = true;
  await assert.rejects(new PgAppDatabase(pg.connect).query(URL, ['ESCALATE'], { write: false }), (err: { code?: string }) => err.code === 'forbidden');
  assert.equal(pg.log.at(-1), 'ROLLBACK');
  assert.ok(!pg.log.includes('COMMIT'));
});

test('reader setup SQL: no login, read-all, SET but not INHERIT for the owner, no signal/create rights', () => {
  assert.match(READER_SETUP_SQL, /CREATE ROLE boxlite_reader NOLOGIN INHERIT BYPASSRLS/);
  assert.match(READER_SETUP_SQL, /GRANT pg_read_all_data TO boxlite_reader/);
  assert.match(READER_SETUP_SQL, /WITH INHERIT FALSE, SET TRUE/);
  assert.doesNotMatch(READER_SETUP_SQL, /pg_signal_backend|pg_write_all_data|GRANT CREATE|LOGIN PASSWORD/);
});

test('a read returning more than MAX_ROWS never materialises more than MAX_ROWS + 1 rows', async () => {
  const pg = new FakePg();
  pg.readerExists = true;
  pg.tables.set('SELECT * FROM big', () => Array.from({ length: 50_000 }, (_, i) => [i]));
  const res = await new PgAppDatabase(pg.connect).query(URL, ['SELECT * FROM big'], { write: false });
  assert.equal(res.rows.length, MAX_ROWS);
  assert.equal(res.truncated, true);
  assert.equal(res.row_count, MAX_ROWS);
  assert.ok(pg.handed <= MAX_ROWS + 1, `handed out ${pg.handed}`);
});

test('wide rows stop at MAX_RESULT_BYTES without pulling much past it', async () => {
  const pg = new FakePg();
  pg.readerExists = true;
  const wide = 'x'.repeat(200 * 1024);
  pg.tables.set('SELECT blob FROM files', () => Array.from({ length: 500 }, () => [wide]));
  const res = await new PgAppDatabase(pg.connect).query(URL, ['SELECT blob FROM files'], { write: false });
  const bytes = Buffer.byteLength(JSON.stringify(res.rows));
  assert.equal(res.truncated, true);
  assert.ok(bytes <= MAX_RESULT_BYTES, `${bytes} bytes returned`);
  assert.ok(res.rows.length >= 20, `${res.rows.length} rows`);
  // At most the first small batch beyond what fits.
  assert.ok(pg.handed <= res.rows.length + 10, `handed out ${pg.handed} for ${res.rows.length} rows`);
});

test('writes drain the whole result (side effects complete) but return at most MAX_ROWS', async () => {
  const pg = new FakePg();
  pg.tables.set('UPDATE big SET n = n + 1 RETURNING n', () => Array.from({ length: 5000 }, (_, i) => [i]));
  const res = await new PgAppDatabase(pg.connect).query(URL, ['UPDATE big SET n = n + 1 RETURNING n'], { write: true });
  assert.equal(res.rows.length, MAX_ROWS);
  assert.equal(res.truncated, true);
  assert.equal(res.row_count, 5000);
  assert.equal(pg.handed, 5000);
});

test('only the last statement is returned; earlier reads are executed, not buffered', async () => {
  const pg = new FakePg();
  pg.readerExists = true;
  pg.tables.set('SELECT * FROM big', () => Array.from({ length: 50_000 }, (_, i) => [i]));
  pg.tables.set('SELECT 2', () => [[2]]);
  const res = await new PgAppDatabase(pg.connect).query(URL, ['SELECT * FROM big', 'SELECT 2'], { write: false });
  assert.deepEqual(res.rows, [[2]]);
  assert.ok(pg.handed <= 2, `handed out ${pg.handed}`);
});
