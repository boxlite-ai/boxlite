import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESULT_BYTES, MAX_ROWS, PgAppDatabase, type DbConn, type DbCursor } from '../src/appdb.js';
import { readerUrl, type ReaderSource } from '../src/dbreader.js';
import { READER_ROLE } from '../src/sqlguard.js';

/**
 * A fake Postgres with just enough semantics to check how PgAppDatabase logs in and wraps
 * statements: which user each connection is, READ ONLY, and how many rows a result hands out.
 */
class FakePg {
  log: string[] = [];
  /** Rows handed out by cursors, across all statements. */
  handed = 0;
  /** Statement text → rows it returns. */
  tables = new Map<string, () => unknown[][]>();
  /** Reader password the "server" accepts. */
  readerPassword = 'pw1';

  connect = async (url: string): Promise<DbConn> => {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    if (user === READER_ROLE && decodeURIComponent(u.password) !== this.readerPassword) {
      throw Object.assign(new Error(`password authentication failed for user '${READER_ROLE}'`), { code: '28P01' });
    }
    this.log.push(`connect ${user}`);
    let readOnly = false;
    const self = this;
    return {
      async query(text: string, values?: unknown[]) {
        self.log.push(values?.length ? `${text} ${JSON.stringify(values)}` : text);
        if (text.startsWith('BEGIN')) readOnly = text !== 'BEGIN';
        return { rows: [] };
      },
      cursor(text: string, values: unknown[]): DbCursor {
        self.log.push(`cursor(${user}${readOnly ? ',ro' : ''}) ${text}${values.length ? ` ${JSON.stringify(values)}` : ''}`);
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

const URL_OWNER = 'postgresql://neondb_owner:pw@ep.neon.test/neondb';

/** Stands in for dbreader.ts: hands out a reader URL, counts refreshes. */
class FakeReaders implements ReaderSource {
  password = 'pw1';
  refreshes = 0;
  constructor(private readonly pg: FakePg) {}
  async urlFor(ownerUrl: string) {
    return readerUrl(ownerUrl, this.password);
  }
  async refresh(ownerUrl: string) {
    this.refreshes++;
    this.password = this.pg.readerPassword;
    return readerUrl(ownerUrl, this.password);
  }
  async prepareBranching() {}
}

function db(pg: FakePg): { db: PgAppDatabase; readers: FakeReaders } {
  const d = new PgAppDatabase(pg.connect);
  const readers = new FakeReaders(pg);
  d.bindReaders(readers);
  return { db: d, readers };
}

test('reads log in as boxlite_reader, run READ ONLY with timeouts, and roll back', async () => {
  const pg = new FakePg();
  pg.tables.set('SELECT 1', () => [[1]]);
  const res = await db(pg).db.query(URL_OWNER, ['SELECT 1'], { write: false });
  assert.deepEqual(res.rows, [[1]]);
  assert.deepEqual(pg.log, [
    `connect ${READER_ROLE}`,
    'BEGIN TRANSACTION READ ONLY',
    `SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true) ["15s","20s"]`,
    `cursor(${READER_ROLE},ro) SELECT 1`,
    'ROLLBACK',
  ]);
});

test('writes log in as the owner and commit', async () => {
  const pg = new FakePg();
  const res = await db(pg).db.query(URL_OWNER, ['UPDATE t SET a = 1'], { write: true });
  assert.equal(res.row_count, 3);
  assert.deepEqual(pg.log, [
    'connect neondb_owner',
    'BEGIN',
    `SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true) ["15s","20s"]`,
    'cursor(neondb_owner) UPDATE t SET a = 1',
    'COMMIT',
  ]);
});

test('a refused reader login re-provisions the reader once, then reads', async () => {
  const pg = new FakePg();
  pg.readerPassword = 'rotated';
  pg.tables.set('SELECT 1', () => [[1]]);
  const { db: d, readers } = db(pg);
  const res = await d.query(URL_OWNER, ['SELECT 1'], { write: false });
  assert.deepEqual(res.rows, [[1]]);
  assert.equal(readers.refreshes, 1);
  assert.equal(pg.log[0], `connect ${READER_ROLE}`);
});

test('without a reader login, reads are refused instead of running as the owner', async () => {
  const pg = new FakePg();
  const d = new PgAppDatabase(pg.connect);
  await assert.rejects(d.query(URL_OWNER, ['SELECT 1'], { write: false }), (err: { code?: string }) => err.code === 'unavailable');
  assert.deepEqual(pg.log, []);
  await d.query(URL_OWNER, ['UPDATE t SET a = 1'], { write: true });
});

test('a read returning more than MAX_ROWS never materialises more than MAX_ROWS + 1 rows', async () => {
  const pg = new FakePg();
  pg.tables.set('SELECT * FROM big', () => Array.from({ length: 50_000 }, (_, i) => [i]));
  const res = await db(pg).db.query(URL_OWNER, ['SELECT * FROM big'], { write: false });
  assert.equal(res.rows.length, MAX_ROWS);
  assert.equal(res.truncated, true);
  assert.equal(res.row_count, MAX_ROWS);
  assert.ok(pg.handed <= MAX_ROWS + 1, `handed out ${pg.handed}`);
});

test('wide rows stop at MAX_RESULT_BYTES without pulling much past it', async () => {
  const pg = new FakePg();
  const wide = 'x'.repeat(200 * 1024);
  pg.tables.set('SELECT blob FROM files', () => Array.from({ length: 500 }, () => [wide]));
  const res = await db(pg).db.query(URL_OWNER, ['SELECT blob FROM files'], { write: false });
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
  const res = await db(pg).db.query(URL_OWNER, ['UPDATE big SET n = n + 1 RETURNING n'], { write: true });
  assert.equal(res.rows.length, MAX_ROWS);
  assert.equal(res.truncated, true);
  assert.equal(res.row_count, 5000);
  assert.equal(pg.handed, 5000);
});

test('only the last statement is returned; earlier reads are executed, not buffered', async () => {
  const pg = new FakePg();
  pg.tables.set('SELECT * FROM big', () => Array.from({ length: 50_000 }, (_, i) => [i]));
  pg.tables.set('SELECT 2', () => [[2]]);
  const res = await db(pg).db.query(URL_OWNER, ['SELECT * FROM big', 'SELECT 2'], { write: false });
  assert.deepEqual(res.rows, [[2]]);
  assert.ok(pg.handed <= 2, `handed out ${pg.handed}`);
});
