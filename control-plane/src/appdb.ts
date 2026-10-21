import pg from 'pg';
import Cursor from 'pg-cursor';
import { fail } from './errors.js';
import type { MigrationFile } from './db.js';
import { authFailure, type ReaderSource } from './dbreader.js';

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
  applyMigration(url: string, m: MigrationFile, deployment: number): Promise<void>;
  query(url: string, statements: string[], opts: { write: boolean; params?: unknown[] }): Promise<QueryResult>;
  /** Provisions the read-only login reads use (idempotent). Also done lazily by `query`. */
  ensureReader(url: string): Promise<void>;
  /** Real Postgres only: where the read-only login comes from (dbreader.ts bindDbReaders). */
  bindReaders?(readers: ReaderSource): void;
}

export const MAX_ROWS = 1000;
/** Serialized size cap of one result; the CP stops reading once it is reached. */
export const MAX_RESULT_BYTES = 5 * 1024 * 1024;
export const STATEMENT_TIMEOUT = '15s';
export const IDLE_IN_TRANSACTION_TIMEOUT = '20s';
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
  end(): Promise<void>;
}

/** pg treats sslmode=require as verify-full with a warning; pass TLS explicitly instead. */
function clientConfig(url: string): pg.ClientConfig {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 30_000 };
}

export async function pgConnect(url: string): Promise<DbConn> {
  const client = new pg.Client(clientConfig(url));
  // A socket/TLS error is also delivered to the pending query (which rejects); without a listener
  // the 'error' event itself would crash the control plane.
  client.on('error', (err) => console.error(`[appdb] connection error: ${err.message}`));
  await client.connect();
  // pg-cursor drops a server error that arrives after it closed its portal; the transaction is then
  // aborted and the next query only says 25P02. Keep the last server error to report the cause.
  let lastServerError: { code?: string; message?: string; position?: string } | null = null;
  (client as unknown as { connection: NodeJS.EventEmitter }).connection.on('errorMessage', (m: { code?: string; message?: string; position?: string }) => {
    if (m.code !== '25P02') lastServerError = m;
  });
  const cause = (err: unknown) => {
    if ((err as { code?: string }).code === '25P02' && lastServerError) throw Object.assign(new Error(lastServerError.message), lastServerError);
    throw err;
  };
  // statement_timeout bounds the server; this bounds the wire. A stalled connection (network,
  // TLS) would otherwise hold the request forever.
  const watch = <T>(p: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        (client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
        reject(fail('unavailable', `the app database did not answer within ${WIRE_TIMEOUT_MS / 1000} s (${what})`, 'wait 30 s and rerun (at most 3 times); `boxlite-app doctor` checks the database'));
      }, WIRE_TIMEOUT_MS);
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
  return {
    query: (text, values) => watch(client.query(text, values as unknown[]), 'query').catch(cause),
    cursor(text, values) {
      const cur = client.query(new Cursor(text, values, { rowMode: 'array' }));
      const result = () => (cur as unknown as { _result: { fields: { name: string }[]; rowCount: number | null } })._result;
      return {
        read: (n) => watch(cur.read(n) as Promise<unknown[][]>, 'read'),
        fields: () => result().fields.map((f) => f.name),
        rowCount: () => result().rowCount,
        close: () => watch(cur.close(), 'close'),
      };
    },
    end: () => Promise.race([client.end(), new Promise<void>((r) => setTimeout(r, 2000).unref())]),
  };
}

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

  constructor(private readonly connect: (url: string) => Promise<DbConn> = pgConnect) {}

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

  private async withConn<T>(url: string, fn: (c: DbConn) => Promise<T>, as: 'owner' | 'reader' = 'owner'): Promise<T> {
    let c: DbConn;
    try {
      c = as === 'reader' ? await this.connectReader(url) : await this.connect(url);
    } catch (err) {
      if ((err as { name?: string }).name === 'HttpError') throw err;
      throw fail('unavailable', `cannot reach the app database: ${(err as Error).message}`, 'wait 30 s and rerun (the database starts on first connection); `boxlite-app doctor` checks it');
    }
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  async listApplied(url: string): Promise<AppliedRow[]> {
    return this.withConn(url, async (c) => {
      const exists = await c.query(`SELECT to_regclass('public.boxlite_migrations') IS NOT NULL AS ok`);
      if (!exists.rows[0]?.ok) return [];
      const r = await c.query(`SELECT file, sha256, deployment, applied_at FROM public.boxlite_migrations ORDER BY file`);
      return r.rows.map((x) => ({ file: String(x.file), sha256: String(x.sha256), deployment: x.deployment as number | null, applied_at: new Date(x.applied_at as string).toISOString() }));
    });
  }

  /**
   * One transaction per file: either the whole file and its bookkeeping row land, or nothing does.
   * The advisory lock serialises concurrent migrators (two envs never share a branch, but a manual
   * SQL session might be running). Files that need to run outside a transaction (CREATE INDEX
   * CONCURRENTLY) are not supported in the prototype. Migrations run as the owner and are not
   * classified: they are reviewed code in the app's repository (CREATE EXTENSION belongs here).
   */
  async applyMigration(url: string, m: MigrationFile, deployment: number): Promise<void> {
    await this.withConn(url, async (c) => {
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
        await c.query(m.sql);
        await c.query('INSERT INTO public.boxlite_migrations (file, sha256, deployment) VALUES ($1, $2, $3)', [m.file, m.sha256, deployment]);
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((err as { name?: string }).name === 'HttpError') throw err;
        throw fail('deploy_failed', `migration ${m.file} failed: ${(err as Error).message}`);
      }
    });
  }

  async ensureReader(url: string): Promise<void> {
    await this.source().refresh(url);
  }

  /** BEGIN (READ ONLY for reads) and the timeouts. */
  private async begin(c: DbConn, write: boolean): Promise<void> {
    await c.query(write ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
    // A SELECT, so the transaction takes its snapshot now: from here on a READ ONLY transaction
    // can no longer be switched to read-write, whatever the statements try.
    await c.query(`SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)`, [STATEMENT_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT]);
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
    return this.withConn(url, async (c) => {
      const started = Date.now();
      try {
        await this.begin(c, opts.write);
        let out: Omit<QueryResult, 'elapsed_ms'> = { columns: [], rows: [], row_count: 0, truncated: false };
        for (let i = 0; i < statements.length; i++) {
          out = await this.run(c, statements[i]!, opts.params ?? [], opts.write, i === statements.length - 1);
        }
        await c.query(opts.write ? 'COMMIT' : 'ROLLBACK');
        return { ...out, elapsed_ms: Date.now() - started };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        sqlError(err);
      }
    }, opts.write ? 'owner' : 'reader');
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
