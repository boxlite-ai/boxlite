/**
 * The read-only database login (security review F5): every read from the SQL endpoint, the table
 * browser and the schema views connects as `boxlite_reader`, not as the branch owner.
 *
 * Neon constraints, verified live on 2026-10-21/22:
 *  - A role created by SQL is a "legacy web access role" to Neon (API shows it as `no_login`), and
 *    any such role in a project makes Neon refuse schema-only branches (412). So the role is
 *    created through the Neon API (`POST …/branches/{b}/roles`), and SQL-created copies left by
 *    the first version of this fix are dropped (API delete, SQL `DROP ROLE` as a fallback).
 *  - An API-created role logs in with a Neon-generated password (`reveal_password`) and is a
 *    member of `neon_superuser`, which the owner can neither revoke nor alter. The CP grants it
 *    `pg_read_all_data` and sets `default_transaction_read_only = on` on it; reads also run in a
 *    READ ONLY transaction and through the SQL guard (sqlguard.ts), which refuses the
 *    neon_superuser powers that still matter in a read-only transaction (signalling backends …).
 *  - Because the session itself is the reader, `RESET ROLE`, `SET ROLE neondb_owner`,
 *    `set_config('role', …)` and `SET SESSION AUTHORIZATION` cannot reach the owner.
 *  - Child branches copy the role, its password and its grants (schema-only and parent-data
 *    alike) once the branch is ready; the password is still fetched per branch.
 *
 * The password is cached per (project, branch) in the CP's sqlite (`db_readers`) and refreshed
 * when a login fails. It never leaves this module: not in specs, logs, the agent context or the
 * console.
 */
import type { AppDatabase, DbConn } from './appdb.js';
import type { Store } from './db.js';
import { now } from './db.js';
import { UpstreamError, fail } from './errors.js';
import { retry, sleep } from './http.js';
import type { NeonClient } from './neon.js';
import { READER_ROLE } from './sqlguard.js';

export interface ReaderSource {
  /** Connection URL of the reader for the database whose owner URL is `ownerUrl`. */
  urlFor(ownerUrl: string): Promise<string>;
  /** Re-provisions the reader (role, grant, password) and returns a fresh URL. */
  refresh(ownerUrl: string): Promise<string>;
}

export function readerUrl(ownerUrl: string, password: string): string {
  const u = new URL(ownerUrl);
  u.username = READER_ROLE;
  u.password = password;
  return u.toString();
}

/** A login failure that a fresh password (or a re-created role) can fix. */
export function authFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === '28P01' || e.code === '28000' || /password authentication failed|role "?boxlite_reader"? does not exist/i.test(e.message ?? '');
}

export class DbReaders implements ReaderSource {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly deps: {
      store: Store;
      neon: NeonClient;
      connect: (url: string) => Promise<DbConn>;
      log?: (line: string) => void;
      /** Waits between reveal_password retries while a new branch is still initialising. */
      retryMs?: number;
    },
  ) {}

  private log(line: string): void {
    (this.deps.log ?? ((l) => console.log(`[db-reader] ${l}`)))(line);
  }

  private locate(ownerUrl: string): { projectId: string; branchId: string } {
    const row = this.deps.store.get<{ project_id: string | null; branch_id: string | null }>(
      'SELECT a.neon_project_id AS project_id, e.neon_branch_id AS branch_id FROM envs e JOIN apps a ON a.id = e.app_id WHERE e.db_url = ?',
      ownerUrl,
    );
    if (!row?.project_id || !row.branch_id) throw fail('unavailable', 'this database has no Neon branch on record', 'run `boxlite-app apply --yes` so the platform provisions it');
    return { projectId: row.project_id, branchId: row.branch_id };
  }

  async urlFor(ownerUrl: string): Promise<string> {
    const { projectId, branchId } = this.locate(ownerUrl);
    const row = this.deps.store.get<{ password: string }>('SELECT password FROM db_readers WHERE project_id = ? AND branch_id = ?', projectId, branchId);
    return row ? readerUrl(ownerUrl, row.password) : this.refresh(ownerUrl);
  }

  /** Single flight per branch: concurrent reads on a fresh branch provision once. */
  refresh(ownerUrl: string): Promise<string> {
    const { projectId, branchId } = this.locate(ownerUrl);
    const key = `${projectId}/${branchId}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.provision(ownerUrl, projectId, branchId).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async provision(ownerUrl: string, projectId: string, branchId: string): Promise<string> {
    const { neon, store } = this.deps;
    try {
      await this.dropLegacy(projectId, branchId, ownerUrl);
      const created = await neon.createRole(projectId, branchId, READER_ROLE);
      const password = await this.reveal(projectId, branchId);
      await this.ownerSql(ownerUrl, [`GRANT pg_read_all_data TO ${READER_ROLE}`]);
      const url = readerUrl(ownerUrl, password);
      await this.verify(url, ownerUrl);
      store.run(
        'INSERT INTO db_readers (project_id, branch_id, password, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, branch_id) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at',
        projectId,
        branchId,
        password,
        now(),
      );
      this.log(`${READER_ROLE} ready on ${projectId}/${branchId} (${created === 'created' ? 'created' : 'already there'})`);
      return url;
    } catch (err) {
      if ((err as { name?: string }).name === 'HttpError') throw err;
      throw fail('unavailable', `cannot prepare the read-only database login: ${(err as Error).message}`, 'retry in a few seconds');
    }
  }

  /** A new branch answers 404 on reveal_password until it is ready (a few seconds). */
  private reveal(projectId: string, branchId: string): Promise<string> {
    return retry(() => this.deps.neon.revealRolePassword(projectId, branchId, READER_ROLE), {
      attempts: 16,
      delayMs: this.deps.retryMs ?? 2000,
      retryable: (err) => err instanceof UpstreamError && err.status === 404,
    });
  }

  /**
   * Logs in as the reader, makes read-only its default (the role can alter its own settings,
   * the owner cannot), and checks the grant took: role changes reach the compute asynchronously.
   */
  private async verify(url: string, ownerUrl: string): Promise<void> {
    for (let i = 0; ; i++) {
      const c = await this.deps.connect(url);
      try {
        // Explicitly read-write: once this setting is on, a plain session would refuse ALTER ROLE.
        await c.query('BEGIN TRANSACTION READ WRITE');
        await c.query(`ALTER ROLE ${READER_ROLE} SET default_transaction_read_only = on`);
        await c.query('COMMIT');
        const r = await c.query(`SELECT pg_has_role(current_user, 'pg_read_all_data', 'USAGE') AS ok`);
        if (r.rows[0]?.ok) return;
      } finally {
        await c.end().catch(() => undefined);
      }
      if (i >= 5) throw new Error(`${READER_ROLE} does not hold pg_read_all_data`);
      await sleep(this.deps.retryMs ?? 2000);
      await this.ownerSql(ownerUrl, [`GRANT pg_read_all_data TO ${READER_ROLE}`]);
    }
  }

  private async ownerSql(url: string, statements: string[]): Promise<void> {
    const c = await this.deps.connect(url);
    try {
      for (const s of statements) await c.query(s);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  /** A SQL-created reader (Neon lists it as `no_login`) blocks schema-only branching: remove it. */
  private async dropLegacy(projectId: string, branchId: string, ownerUrl?: string): Promise<boolean> {
    const { neon, store } = this.deps;
    const role = await neon.getRole(projectId, branchId, READER_ROLE);
    if (!role || role.authMethod !== 'no_login') return false;
    try {
      await neon.deleteRole(projectId, branchId, READER_ROLE);
    } catch (err) {
      this.log(`API delete of the SQL-created ${READER_ROLE} on ${projectId}/${branchId} failed (${(err as Error).message}); dropping it by SQL`);
      const url = ownerUrl ?? (await neon.connectionUri(projectId, branchId));
      await this.ownerSql(url, [`REVOKE pg_read_all_data FROM ${READER_ROLE}`, `DROP ROLE ${READER_ROLE}`]);
    }
    store.run('DELETE FROM db_readers WHERE project_id = ? AND branch_id = ?', projectId, branchId);
    this.log(`dropped the SQL-created ${READER_ROLE} on ${projectId}/${branchId}`);
    return true;
  }

  /** No branch of the project may hold a SQL-created reader (start-up pass only, see migrateAll). */
  async prepareBranching(projectId: string): Promise<void> {
    for (const b of await this.deps.neon.listBranches(projectId)) await this.dropLegacy(projectId, b.id);
  }

  /**
   * Start-up pass for databases provisioned before the reader moved to the Neon API: clear
   * SQL-created readers on every branch, then provision the API reader for every env database.
   * Failures are logged; reads provision lazily anyway.
   */
  async migrateAll(): Promise<void> {
    const { store } = this.deps;
    for (const app of store.all<{ id: string; name: string; neon_project_id: string }>('SELECT id, name, neon_project_id FROM apps WHERE neon_project_id IS NOT NULL AND deleted_at IS NULL')) {
      try {
        await this.prepareBranching(app.neon_project_id);
        for (const env of store.all<{ name: string; db_url: string }>('SELECT name, db_url FROM envs WHERE app_id = ? AND db_url IS NOT NULL AND neon_branch_id IS NOT NULL', app.id)) {
          const known = store.get('SELECT 1 AS ok FROM db_readers r JOIN envs e ON e.neon_branch_id = r.branch_id WHERE e.db_url = ?', env.db_url);
          if (!known) await this.refresh(env.db_url);
        }
      } catch (err) {
        this.log(`start-up pass for ${app.name} failed: ${(err as Error).message}`);
      }
    }
  }
}

/** Wires the reader into the app database (real Postgres only) and runs the start-up pass. */
export function bindDbReaders(ctx: { store: Store; neon: NeonClient; appdb: AppDatabase }, connect: (url: string) => Promise<DbConn>): DbReaders | null {
  if (!ctx.appdb.bindReaders) return null;
  const readers = new DbReaders({ store: ctx.store, neon: ctx.neon, connect });
  ctx.appdb.bindReaders(readers);
  setTimeout(() => void readers.migrateAll().catch(() => undefined), 0).unref();
  return readers;
}
