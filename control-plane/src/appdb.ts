import type { Readable } from 'node:stream';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { fail } from './errors.js';
import type { MigrationFile } from './db.js';
import { authFailure, type ReaderSource } from './dbreader.js';
import * as transfer from './dbtransfer.js';

export interface AppliedRow {
  file: string;
  sha256: string;
  deployment: number | null;
  applied_at: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows returned (or affected, for DML). When `truncated` on a read, the rows read before stopping. */
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
}

/**
 * Everything the CP does inside an app's Postgres. An interface so the orchestrator tests can run
 * without a database.
 */
export interface AppDatabase {
  listApplied(url: string): Promise<AppliedRow[]>;
  /**
   * Copies the migrations ledger (public.boxlite_migrations) from one database to another. A
   * schema-only branch has the parent's tables but not this table's rows, so without the copy its
   * first deploy would run every migration again. Returns the rows copied.
   */
  copyMigrationLedger(from: string, to: string): Promise<number>;
  applyMigration(url: string, m: MigrationFile, deployment: number): Promise<void>;
  query(url: string, statements: string[], opts: { write: boolean; params?: unknown[] }): Promise<QueryResult>;
  /** Provisions the read-only login reads use (idempotent). Also done lazily by `query`. */
  ensureReader(url: string): Promise<void>;
  /** Real Postgres only: where the read-only login comes from (dbreader.ts bindDbReaders). */
  bindReaders?(readers: ReaderSource): void;
  /**
   * Real Postgres only: the login URL of `as` on the database whose owner URL is `url`, for the
   * connections the CP makes on a caller's behalf (db proxy, export, import). `refresh` re-fetches
   * the reader's password after a refused login. The URL carries a password: it never leaves the CP.
   */
  loginUrl?(url: string, as: 'owner' | 'reader', opts?: { refresh?: boolean }): Promise<string>;
  /** Real Postgres only (dbtransfer.ts): one table as CSV, as the reader. */
  exportCsv?(url: string, table: string): Promise<Readable>;
  /** Real Postgres only (dbtransfer.ts): schema + data of public (or one table) as SQL, as the reader. */
  exportSql?(url: string, opts: { table?: string; title: string }): Promise<Readable>;
  /** Real Postgres only (dbtransfer.ts): COPY a CSV (header = `columns`) into a table as the owner; rows written. */
  importCsv?(url: string, table: string, columns: string[], csv: Readable): Promise<number>;
}

export const MAX_ROWS = 1000;
/** Serialized size cap of one result; the CP stops reading once it is reached. */
export const MAX_RESULT_BYTES = 5 * 1024 * 1024;
export const STATEMENT_TIMEOUT = '15s';
export const IDLE_IN_TRANSACTION_TIMEOUT = '20s';
/** The per-transaction guard rails, run right after BEGIN. */
const BEGIN_SETTINGS = `SELECT set_config('statement_timeout', '${STATEMENT_TIMEOUT}', true), set_config('idle_in_transaction_session_timeout', '${IDLE_IN_TRANSACTION_TIMEOUT}', true)`;
/** Client-side bound on any single round trip (above statement_timeout). */
export const WIRE_TIMEOUT_MS = 30_000;
/** Rows pulled per round trip while collecting (the first batch is small until the row width is known). */
const BATCH = 1000;
const FIRST_BATCH = 10;
/** Upper bound per round trip when a write's rows are only counted. */
const DRAIN_BATCH = 10_000;

const MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS public.boxlite_migrations (
  file text PRIMARY KEY,
  sha256 text NOT NULL,
  deployment int,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** The few things the CP needs from a connection; real pg below, a fake in tests. */
export interface DbCursor {
  read(n: number): Promise<unknown[][]>;
  /** Column names; known after the first read. */
  fields(): string[];
  /** Command tag row count once the statement completed (DML: rows affected). */
  rowCount(): number | null;
  close(): Promise<void>;
}

export interface DbConn {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  cursor(text: string, values: unknown[]): DbCursor;
  /** Hands the connection back (pooled) or closes it. */
  end(): Promise<void>;
  /** A pooled connection that served an earlier caller (it may have died while idle). */
  reused?: boolean;
}

/** pg treats sslmode=require as verify-full with a warning; pass TLS explicitly instead. */
export function clientConfig(url: string): pg.ClientConfig {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 30_000, keepAlive: true };
}

type ServerError = { code?: string; message?: string; position?: string };

/** Per physical connection: the last server error (see `wrap`) and whether it served a caller before. */
interface ConnState {
  lastServerError: ServerError | null;
  used: boolean;
}

const states = new WeakMap<pg.Client, ConnState>();

/**
 * Listeners every connection needs once, whether pooled or not. A socket/TLS error is also
 * delivered to the pending query (which rejects); without a listener the 'error' event itself
 * would crash the control plane. pg-cursor drops a server error that arrives after it closed its
 * portal; the transaction is then aborted and the next query only says 25P02, so the last server
 * error is kept to report the cause.
 */
function track(client: pg.Client): ConnState {
  let state = states.get(client);
  if (state) return state;
  state = { lastServerError: null, used: false };
  states.set(client, state);
  const s = state;
  client.on('error', (err) => console.error(`[appdb] connection error: ${err.message}`));
  (client as unknown as { connection: NodeJS.EventEmitter }).connection.on('errorMessage', (m: ServerError) => {
    if (m.code !== '25P02') s.lastServerError = m;
  });
  return state;
}

/**
 * A DbConn over one pg client. `release(broken)` hands the client back: `broken` is true once the
 * wire timed out or the connection failed, so a pool destroys it instead of reusing it.
 */
function wrap(client: pg.Client, state: ConnState, reused: boolean, release: (broken: boolean) => Promise<void>): DbConn {
  let broken = false;
  const cause = (err: unknown) => {
    if (isConnectionError(err)) broken = true;
    if ((err as { code?: string }).code === '25P02' && state.lastServerError) throw Object.assign(new Error(state.lastServerError.message), state.lastServerError);
    throw err;
  };
  // statement_timeout bounds the server; this bounds the wire. A stalled connection (network,
  // TLS) would otherwise hold the request forever.
  const watch = <T>(p: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        broken = true;
        (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
        reject(fail('unavailable', `the app database did not answer within ${WIRE_TIMEOUT_MS / 1000} s (${what})`, 'wait 30 s and rerun (at most 3 times); `boxlite-app doctor` checks the database'));
      }, WIRE_TIMEOUT_MS);
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
  let ended = false;
  return {
    reused,
    query: (text, values) => watch(client.query(text, values as unknown[]), 'query').catch(cause),
    cursor(text, values) {
      const cur = client.query(new Cursor(text, values, { rowMode: 'array' }));
      const result = () => (cur as unknown as { _result: { fields: { name: string }[]; rowCount: number | null } })._result;
      return {
        read: (n) => watch(cur.read(n) as Promise<unknown[][]>, 'read').catch(cause),
        fields: () => result().fields.map((f) => f.name),
        rowCount: () => result().rowCount,
        close: () => watch(cur.close(), 'close'),
      };
    },
    end: () => {
      if (ended) return Promise.resolve();
      ended = true;
      return release(broken);
    },
  };
}

/** One unpooled connection (the reader provisioning in dbreader.ts, long transfers). */
export async function pgConnect(url: string): Promise<DbConn> {
  const client = new pg.Client(clientConfig(url));
  const state = track(client);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return wrap(client, state, false, () => Promise.race([client.end(), new Promise<void>((r) => setTimeout(r, 2000).unref())]));
}

export const POOL_MAX = 3;
export const POOL_IDLE_MS = 30_000;

/**
 * Small connection pools, one per login URL, i.e. per (database, role): the owner and the reader
 * of a branch never share a connection. At most POOL_MAX connections each; a connection idle for
 * POOL_IDLE_MS is closed, and a pool whose last connection closed is dropped, so an App nobody
 * looks at holds no connection (Neon can scale its compute to zero).
 *
 * Session state never travels between callers: every unit of work runs in its own transaction
 * with SET LOCAL-style settings, and before a connection goes back to the pool it runs DISCARD
 * ALL, which resets what a committed statement may leave on the session (SET without LOCAL, WITH
 * HOLD cursors, temp tables, session advisory locks, prepared statements, LISTEN). A connection
 * whose DISCARD fails, or that broke, is destroyed instead. DISCARD ALL cannot share a message
 * with anything else, so it costs a round trip: it runs after the caller already has its result,
 * and a caller that finds no idle connection waits for a reset in flight (one round trip) rather
 * than opening a new connection (TCP, TLS, SCRAM and Neon's proxy: several).
 */
export class PgPools {
  private readonly pools = new Map<string, pg.Pool>();
  /** Per pool: DISCARD ALL calls in flight, each settling once its connection is back in the pool. */
  private readonly resetting = new Map<string, Set<Promise<void>>>();

  constructor(private readonly opts: { max?: number; idleMs?: number } = {}) {}

  /** Pools currently open (tests). */
  get size(): number {
    return this.pools.size;
  }

  private pool(url: string): pg.Pool {
    const existing = this.pools.get(url);
    if (existing) return existing;
    const pool = new pg.Pool({ ...clientConfig(url), max: this.opts.max ?? POOL_MAX, idleTimeoutMillis: this.opts.idleMs ?? POOL_IDLE_MS });
    pool.on('connect', (client) => void track(client));
    // An idle connection that dies (Neon suspended the compute, a network reset) is removed by
    // the pool; the next caller gets a fresh one.
    pool.on('error', (err) => console.error(`[appdb] idle pooled connection failed: ${err.message}`));
    pool.on('remove', () => {
      if (pool.totalCount === 0 && pool.waitingCount === 0 && this.pools.get(url) === pool) {
        this.pools.delete(url);
        void pool.end().catch(() => undefined);
      }
    });
    this.pools.set(url, pool);
    return pool;
  }

  acquire = async (url: string): Promise<DbConn> => {
    const inflight = this.resetting.get(url);
    if (inflight?.size && !this.pools.get(url)?.idleCount) await Promise.race(inflight);
    // pool() and connect() run in the same tick, so a pool being dropped is never handed out.
    const client = await this.pool(url).connect();
    const state = track(client);
    const reused = state.used;
    state.used = true;
    state.lastServerError = null;
    return wrap(client, state, reused, async (broken) => {
      if (broken) {
        client.release(true);
        return;
      }
      let set = this.resetting.get(url);
      if (!set) this.resetting.set(url, (set = new Set()));
      const done: Promise<void> = client.query('DISCARD ALL').then(
        () => client.release(),
        () => client.release(true),
      );
      const tracked = done.finally(() => {
        set.delete(tracked);
        if (!set.size && this.resetting.get(url) === set) this.resetting.delete(url);
      });
      set.add(tracked);
    });
  };

  async close(): Promise<void> {
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(all.map((p) => p.end().catch(() => undefined)));
  }
}

/** The pools PgAppDatabase uses by default (one per CP process). */
export const defaultPools = new PgPools();

/** A Postgres SQLSTATE (5 characters), as opposed to a Node errno code (ECONNRESET, EPIPE, …). */
function sqlstateOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; errno?: unknown; syscall?: unknown };
  return typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.errno === undefined && e.syscall === undefined ? e.code : undefined;
}

/**
 * Not the statement's fault: the connection broke (no SQLSTATE: reset, timeout, terminated),
 * class 08 (connection exception), 53 (insufficient resources, e.g. too many connections), or 57P
 * (the server shut down or restarted). 57014, a statement cancelled by statement_timeout, is the
 * query's own problem and stays a sql_error.
 */
function connectionFailure(sqlstate: string | undefined): boolean {
  return sqlstate === undefined || sqlstate.startsWith('08') || sqlstate.startsWith('53') || sqlstate.startsWith('57P');
}

/** A connection-class failure (see connectionFailure) rather than the statement's or the CP's own error. */
export function isConnectionError(err: unknown): boolean {
  if ((err as { name?: string }).name === 'HttpError') return false;
  return connectionFailure(sqlstateOf(err));
}

/** Thrown inside a unit of work once retrying it is no longer safe (a write's statements were sent). */
class NoRetry extends Error {
  constructor(readonly inner: unknown) {
    super('no retry');
  }
}

function sqlError(err: unknown): never {
  if ((err as { name?: string }).name === 'HttpError') throw err;
  const e = err as { message?: string; position?: string; code?: string };
  if (connectionFailure(sqlstateOf(err))) {
    throw fail('unavailable', `the connection to the app database failed: ${e.message ?? String(err)}`, 'wait 30 s and rerun (the database starts on first connection); `boxlite-app doctor` checks it');
  }
  // 25006: read_only_sql_transaction. The guard catches plain DML first; this covers the rest
  // (functions that write, writable CTEs the parser classifies as reads).
  const next = e.code === '25006' ? 'this statement writes; rerun it with --write' : undefined;
  throw fail('sql_error', e.message ?? String(err), next, { sqlstate: e.code, position: e.position ? Number(e.position) : undefined });
}

function rowBytes(row: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(row) ?? '') + 1;
  } catch {
    return 1;
  }
}

export class PgAppDatabase implements AppDatabase {
  private readers: ReaderSource | null = null;

  constructor(private readonly connect: (url: string) => Promise<DbConn> = defaultPools.acquire) {}

  /** The read-only login (dbreader.ts). Without it reads are refused rather than run as the owner. */
  bindReaders(readers: ReaderSource): void {
    this.readers = readers;
  }

  private source(): ReaderSource {
    if (!this.readers) throw fail('unavailable', 'the read-only database login is not configured on this control plane', 'nothing in the app can fix this: tell the user the platform operator must configure the read-only database login');
    return this.readers;
  }

  /** Reads connect as boxlite_reader; a refused login re-provisions it once. */
  private async connectReader(ownerUrl: string): Promise<DbConn> {
    const readers = this.source();
    try {
      return await this.connect(await readers.urlFor(ownerUrl));
    } catch (err) {
      if (!authFailure(err)) throw err;
      return this.connect(await readers.refresh(ownerUrl));
    }
  }

  private async open(url: string, as: 'owner' | 'reader'): Promise<DbConn> {
    return as === 'reader' ? this.connectReader(url) : this.connect(url);
  }

  /**
   * Runs `fn` on a (pooled) connection. A connection-class failure (a pooled connection that
   * died while idle, Neon scaling to zero, a reset) is retried once on a fresh connection, unless
   * `fn` signalled with `noRetry()` that it already sent statements whose effect is unknown.
   */
  private async withConn<T>(url: string, fn: (c: DbConn, noRetry: (err: unknown) => never) => Promise<T>, as: 'owner' | 'reader' = 'owner'): Promise<T> {
    const noRetry = (err: unknown): never => {
      throw new NoRetry(err);
    };
    for (let attempt = 1; ; attempt++) {
      let c: DbConn;
      try {
        c = await this.open(url, as);
      } catch (err) {
        if ((err as { name?: string }).name === 'HttpError') throw err;
        if (attempt === 1 && isConnectionError(err)) continue;
        throw fail('unavailable', `cannot reach the app database: ${(err as Error).message}`, 'wait 30 s and rerun (the database starts on first connection); `boxlite-app doctor` checks it');
      }
      try {
        return await fn(c, noRetry);
      } catch (err) {
        if (err instanceof NoRetry) throw err.inner;
        if (attempt === 1 && isConnectionError(err)) continue;
        throw err;
      } finally {
        await c.end().catch(() => undefined);
      }
    }
  }

  async copyMigrationLedger(from: string, to: string): Promise<number> {
    const rows = await this.listApplied(from);
    if (!rows.length) return 0;
    return this.withConn(to, async (c) => {
      await c.query(MIGRATIONS_DDL);
      for (const r of rows) {
        await c.query('INSERT INTO public.boxlite_migrations (file, sha256, deployment, applied_at) VALUES ($1, $2, $3, $4) ON CONFLICT (file) DO NOTHING', [r.file, r.sha256, r.deployment, r.applied_at]);
      }
      return rows.length;
    }).catch(sqlError);
  }

  async listApplied(url: string): Promise<AppliedRow[]> {
    return this.withConn(url, async (c) => {
      const exists = await c.query(`SELECT to_regclass('public.boxlite_migrations') IS NOT NULL AS ok`);
      if (!exists.rows[0]?.ok) return [];
      const r = await c.query(`SELECT file, sha256, deployment, applied_at FROM public.boxlite_migrations ORDER BY file`);
      return r.rows.map((x) => ({ file: String(x.file), sha256: String(x.sha256), deployment: x.deployment as number | null, applied_at: new Date(x.applied_at as string).toISOString() }));
    }).catch(sqlError);
  }

  /**
   * One transaction per file: either the whole file and its bookkeeping row land, or nothing does.
   * The advisory lock serialises concurrent migrators (two envs never share a branch, but a manual
   * SQL session might be running). Files that need to run outside a transaction (CREATE INDEX
   * CONCURRENTLY) are not supported in the prototype. Migrations run as the owner and are not
   * classified: they are reviewed code in the app's repository (CREATE EXTENSION belongs here).
   * A connection failure before the file's SQL was sent is retried once; after, it fails the deploy.
   */
  async applyMigration(url: string, m: MigrationFile, deployment: number): Promise<void> {
    await this.withConn(url, async (c, noRetry) => {
      await c.query(MIGRATIONS_DDL);
      await c.query('BEGIN');
      try {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('boxlite_migrations'))`);
        const prev = await c.query('SELECT sha256 FROM public.boxlite_migrations WHERE file = $1', [m.file]);
        if (prev.rows[0]) {
          await c.query('ROLLBACK');
          if (prev.rows[0].sha256 !== m.sha256) throw fail('invalid_manifest', `migration ${m.file} was already applied with different contents`, 'never edit an applied migration; add a new NNNN_*.sql file instead');
          return;
        }
        try {
          await c.query(m.sql);
          await c.query('INSERT INTO public.boxlite_migrations (file, sha256, deployment) VALUES ($1, $2, $3)', [m.file, m.sha256, deployment]);
          await c.query('COMMIT');
        } catch (err) {
          noRetry(err);
        }
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }).catch((err) => {
      if ((err as { name?: string }).name === 'HttpError') throw err;
      throw fail('deploy_failed', `migration ${m.file} failed: ${(err as Error).message}`);
    });
  }

  async loginUrl(url: string, as: 'owner' | 'reader', opts: { refresh?: boolean } = {}): Promise<string> {
    if (as === 'owner') return url;
    return opts.refresh ? this.source().refresh(url) : this.source().urlFor(url);
  }

  /** A dedicated connection for a transfer (dbtransfer.ts); a refused reader login re-provisions it once. */
  private async transferClient(url: string, as: 'owner' | 'reader'): Promise<pg.Client> {
    const open = async (login: string) => {
      const client = new pg.Client(clientConfig(login));
      client.on('error', (err) => console.error(`[appdb] transfer connection error: ${err.message}`));
      try {
        await client.connect();
      } catch (err) {
        await client.end().catch(() => undefined);
        throw err;
      }
      return client;
    };
    try {
      return await open(await this.loginUrl(url, as));
    } catch (err) {
      if (as !== 'reader' || !authFailure(err)) throw err;
      return open(await this.loginUrl(url, as, { refresh: true }));
    }
  }

  exportCsv(url: string, table: string): Promise<Readable> {
    return transfer.exportCsv(() => this.transferClient(url, 'reader'), table).catch(sqlError);
  }

  exportSql(url: string, opts: { table?: string; title: string }): Promise<Readable> {
    return transfer.exportSql(() => this.transferClient(url, 'reader'), opts).catch(sqlError);
  }

  importCsv(url: string, table: string, columns: string[], csv: Readable): Promise<number> {
    return transfer.importCsv(() => this.transferClient(url, 'owner'), table, columns, csv).catch(sqlError);
  }

  async ensureReader(url: string): Promise<void> {
    await this.source().refresh(url);
  }

  /** BEGIN (READ ONLY for reads) and the timeouts. */
  private async begin(c: DbConn, write: boolean): Promise<void> {
    // One message, one round trip (simple protocol: the settings are CP constants, not input).
    // set_config(…, true) is SET LOCAL: it ends with the transaction, so nothing of it outlives
    // this caller on a pooled connection. And it is a SELECT, so the transaction takes its
    // snapshot now: from here on a READ ONLY transaction can no longer be switched to read-write,
    // whatever the statements try.
    await c.query(`${write ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY'}; ${BEGIN_SETTINGS}`);
  }

  /**
   * Runs statements inside one transaction and returns the last one's result.
   *
   * Reads: connected as boxlite_reader (dbreader.ts), `BEGIN TRANSACTION READ ONLY`, rolled back.
   * Postgres itself refuses writes; the session is the reader, so no SET/RESET ROLE reaches the
   * owner. Writes (`write: true`) connect as the owner and commit.
   *
   * Results are streamed with a cursor in batches, so neither a huge row count nor huge rows are
   * ever held beyond MAX_ROWS rows / MAX_RESULT_BYTES. On reads the CP stops reading at the cap;
   * on writes it keeps draining (discarding) so a statement with side effects runs to completion.
   * Each statement goes through the extended protocol, which rejects multiple commands in one
   * message, so a statement cannot smuggle in a COMMIT.
   */
  async query(url: string, statements: string[], opts: { write: boolean; params?: unknown[] }): Promise<QueryResult> {
    return this.withConn(
      url,
      async (c, noRetry) => {
        const started = Date.now();
        try {
          await this.begin(c, opts.write);
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw err; // nothing of the caller's ran yet: retryable
        }
        try {
          let out: Omit<QueryResult, 'elapsed_ms'> = { columns: [], rows: [], row_count: 0, truncated: false };
          for (let i = 0; i < statements.length; i++) {
            out = await this.run(c, statements[i]!, opts.params ?? [], opts.write, i === statements.length - 1);
          }
          await c.query(opts.write ? 'COMMIT' : 'ROLLBACK');
          return { ...out, elapsed_ms: Date.now() - started };
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          // A read is rolled back whatever happened, so running it again is safe. A write whose
          // statements were sent is not retried: if the connection died during COMMIT, nobody
          // knows whether it landed.
          if (opts.write) noRetry(err);
          throw err;
        }
      },
      opts.write ? 'owner' : 'reader',
    ).catch(sqlError);
  }

  private async run(c: DbConn, text: string, params: unknown[], write: boolean, last: boolean): Promise<Omit<QueryResult, 'elapsed_ms'>> {
    const cur = c.cursor(text, params);
    const rows: unknown[][] = [];
    let bytes = 0;
    let seen = 0;
    let sampled = 0;
    let sampledBytes = 0;
    let truncated = false;
    try {
      for (;;) {
        // Average serialized row size so far (sampled per batch), to size batches by bytes.
        const avg = sampled ? sampledBytes / sampled : 0;
        if (!write && !last) {
          await cur.read(1); // executes the statement; nothing of a read needs finishing
          break;
        }
        let want: number;
        if (write && (!last || truncated)) {
          // Draining a write whose rows are only counted: ~MAX_RESULT_BYTES per round trip. The
          // statement_timeout spans the whole drain (until Sync), so few round trips matter.
          want = avg ? Math.max(FIRST_BATCH, Math.min(DRAIN_BATCH, Math.floor(MAX_RESULT_BYTES / avg))) : FIRST_BATCH;
        } else {
          // Collecting. One row past the cap tells "exactly MAX_ROWS" from "more"; the batch also
          // shrinks with the bytes still allowed, so wide rows are never pulled much past the cap.
          const byBytes = avg ? Math.floor((MAX_RESULT_BYTES - bytes) / avg) + 1 : FIRST_BATCH;
          want = Math.max(1, Math.min(BATCH, MAX_ROWS + 1 - rows.length, byBytes));
        }
        const batch = await cur.read(want);
        if (!batch.length) break;
        seen += batch.length;
        sampled++;
        sampledBytes += rowBytes(batch[0]);
        if (last) {
          for (const row of batch) {
            if (truncated) break;
            const size = rowBytes(row);
            if (rows.length >= MAX_ROWS || bytes + size > MAX_RESULT_BYTES) truncated = true;
            else {
              rows.push(row);
              bytes += size;
            }
          }
        }
        if (truncated && !write) break;
      }
      const columns = cur.fields();
      const count = columns.length ? seen : (cur.rowCount() ?? seen);
      // A read that stopped at the cap does not know the total; report what it returns.
      return { columns, rows, row_count: truncated && !write ? rows.length : count, truncated };
    } finally {
      await cur.close().catch(() => undefined);
    }
  }
}
