import pg from 'pg';
import Cursor from 'pg-cursor';
import { fail } from './errors.js';
import type { MigrationFile } from './db.js';
import { READER_ROLE } from './sqlguard.js';

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
  /** Creates the read-only role reads run as (idempotent). Also done lazily by `query`. */
  ensureReader(url: string): Promise<void>;
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

/**
 * The role every read from the SQL endpoint, the table browser and the schema views runs as
 * (`SET LOCAL ROLE` inside a READ ONLY transaction). It reads everything (pg_read_all_data,
 * BYPASSRLS so RLS tables look the same as they do to the owner) and can do nothing else: no
 * pg_signal_backend, no CREATE, cannot log in. Neon's owner may grant BYPASSRLS (it has it); a
 * Postgres where it may not still gets the role, without it.
 *
 * Postgres 16+ gives the role's creator ADMIN but not SET on it, so the owner grants itself
 * SET (not INHERIT) explicitly; that is what lets `SET ROLE boxlite_reader` work.
 * TEMP: the database grants it to PUBLIC, and revoking that would change the app's own roles,
 * but a READ ONLY transaction refuses CREATE TEMP TABLE anyway.
 */
export const READER_SETUP_SQL = `DO $boxlite$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('${READER_ROLE}'));
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READER_ROLE}') THEN
    BEGIN
      CREATE ROLE ${READER_ROLE} NOLOGIN INHERIT BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      CREATE ROLE ${READER_ROLE} NOLOGIN INHERIT;
    END;
  END IF;
  GRANT pg_read_all_data TO ${READER_ROLE};
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT ${READER_ROLE} TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT ${READER_ROLE} TO %I', current_user);
  END IF;
END
$boxlite$`;

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
        reject(fail('unavailable', `the app database did not answer within ${WIRE_TIMEOUT_MS / 1000} s (${what})`, 'retry in a few seconds'));
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

function sqlError(err: unknown): never {
  if ((err as { name?: string }).name === 'HttpError') throw err;
  const e = err as { message?: string; position?: string; code?: string };
  throw fail('sql_error', e.message ?? String(err), undefined, { sqlstate: e.code, position: e.position ? Number(e.position) : undefined });
}

/** `SET ROLE boxlite_reader` failed because the role is missing or the owner may not SET it yet. */
function readerMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  // Postgres answers a missing role in SET ROLE with 22023 (invalid_parameter_value).
  if ((e.code === '22023' || e.code === '42704') && /role .* does not exist/i.test(e.message ?? '')) return true;
  return e.code === '42501' && /set role/i.test(e.message ?? '');
}

function rowBytes(row: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(row) ?? '') + 1;
  } catch {
    return 1;
  }
}

export class PgAppDatabase implements AppDatabase {
  constructor(private readonly connect: (url: string) => Promise<DbConn> = pgConnect) {}

  private async withConn<T>(url: string, fn: (c: DbConn) => Promise<T>): Promise<T> {
    let c: DbConn;
    try {
      c = await this.connect(url);
    } catch (err) {
      throw fail('unavailable', `cannot reach the app database: ${(err as Error).message}`, 'retry in a few seconds; Neon computes start on first connection');
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
    await this.withConn(url, (c) => this.setupReader(c));
  }

  private async setupReader(c: DbConn): Promise<void> {
    await c.query('BEGIN');
    try {
      await c.query(READER_SETUP_SQL);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw fail('unavailable', `cannot prepare the read-only database role: ${(err as Error).message}`, 'retry; if it persists the database owner lacks CREATEROLE');
    }
  }

  /** BEGIN, drop to the reader role on reads, timeouts. Creates the reader on first use. */
  private async begin(c: DbConn, write: boolean): Promise<void> {
    await c.query(write ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
    if (!write) {
      try {
        await c.query(`SET LOCAL ROLE ${READER_ROLE}`);
      } catch (err) {
        if (!readerMissing(err)) throw err;
        await c.query('ROLLBACK');
        await this.setupReader(c);
        await c.query('BEGIN TRANSACTION READ ONLY');
        await c.query(`SET LOCAL ROLE ${READER_ROLE}`);
      }
    }
    // A SELECT, so the transaction takes its snapshot now: from here on a READ ONLY transaction
    // can no longer be switched to read-write, whatever the statements try.
    await c.query(`SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)`, [STATEMENT_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT]);
  }

  /**
   * Runs statements inside one transaction and returns the last one's result.
   *
   * Reads: `BEGIN TRANSACTION READ ONLY` + `SET LOCAL ROLE boxlite_reader`, rolled back. Postgres
   * itself refuses writes, and the role has no rights beyond reading. Afterwards `current_user`
   * must still be the reader; if a statement found a way back to the owner the result is
   * discarded. Writes (`write: true`) run as the owner and commit.
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
        if (!opts.write) {
          const who = await c.query('SELECT current_user AS u');
          if (who.rows[0]?.u !== READER_ROLE) throw fail('forbidden', 'the query changed the role it runs as', 'read queries run as a read-only role; do not change roles or session settings');
        }
        await c.query(opts.write ? 'COMMIT' : 'ROLLBACK');
        return { ...out, elapsed_ms: Date.now() - started };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        sqlError(err);
      }
    });
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
