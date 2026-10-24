/**
 * Tests against a real Postgres run only when one is configured:
 *  - MICROCLOUD_TEST_PG_URL: a superuser login, e.g.
 *      docker run -d -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17
 *      MICROCLOUD_TEST_PG_URL=postgresql://postgres:pw@127.0.0.1:55432/postgres pnpm test
 *    Each suite gets its own database, owned by its own role, plus the cluster-wide reader role set
 *    up the way dbreader.ts sets it up on Neon (pg_read_all_data, read-only by default).
 *  - or MICROCLOUD_TEST_PG_OWNER_URL + MICROCLOUD_TEST_PG_READER_URL: a throwaway database (a Neon
 *    project with boxlite_reader made through the Neon API, as dbreader.ts does). Suites share it
 *    and reset its public schema when they finish.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { READER_ROLE } from '../src/sqlguard.js';

export const LIVE_PG = process.env.MICROCLOUD_TEST_PG_URL ?? '';
const OWNER = process.env.MICROCLOUD_TEST_PG_OWNER_URL ?? '';
const READER = process.env.MICROCLOUD_TEST_PG_READER_URL ?? '';
export const skipLive = LIVE_PG || (OWNER && READER) ? false : 'set MICROCLOUD_TEST_PG_URL (or _OWNER_URL + _READER_URL) to run against a real Postgres';

/** pg wants TLS spelled out for a remote database (see appdb.ts clientConfig). */
export function pgConfig(url: string): pg.ClientConfig {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  return { connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: true } };
}

export interface LiveDb {
  /** Owner login of the suite's database (what envs.db_url holds). */
  ownerUrl: string;
  readerUrl: string;
  /** Superuser connection to the suite's database. */
  admin: pg.Client;
  drop(): Promise<void>;
}

const READER_PASSWORD = 'reader-test-pw';

export async function liveDb(): Promise<LiveDb> {
  if (!LIVE_PG) {
    const admin = new pg.Client(pgConfig(OWNER));
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
    return {
      ownerUrl: OWNER,
      readerUrl: READER,
      admin,
      async drop() {
        await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public').catch(() => undefined);
        await admin.end().catch(() => undefined);
      },
    };
  }
  const name = `mc_${randomBytes(4).toString('hex')}`;
  const root = new pg.Client({ connectionString: LIVE_PG });
  await root.connect();
  const ownerPw = randomBytes(8).toString('hex');
  await root.query(`CREATE ROLE ${name} LOGIN PASSWORD '${ownerPw}'`);
  await root.query(`CREATE DATABASE ${name} OWNER ${name}`);
  const reader = await root.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [READER_ROLE]);
  if (!reader.rowCount) await root.query(`CREATE ROLE ${READER_ROLE} LOGIN PASSWORD '${READER_PASSWORD}'`);
  await root.query(`ALTER ROLE ${READER_ROLE} LOGIN PASSWORD '${READER_PASSWORD}'`);
  await root.query(`GRANT pg_read_all_data TO ${READER_ROLE}`);
  await root.query(`ALTER ROLE ${READER_ROLE} SET default_transaction_read_only = on`);
  const base = new URL(LIVE_PG);
  const at = (user: string, pw: string) => {
    const u = new URL(base);
    u.username = user;
    u.password = pw;
    u.pathname = `/${name}`;
    return u.toString();
  };
  const adminUrl = new URL(base);
  adminUrl.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  // PG 15+: only the database owner may create in public; the suite's owner owns the database.
  await admin.query(`ALTER SCHEMA public OWNER TO ${name}`);
  return {
    ownerUrl: at(name, ownerPw),
    readerUrl: at(READER_ROLE, READER_PASSWORD),
    admin,
    async drop() {
      await admin.end().catch(() => undefined);
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await root.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
      await root.end().catch(() => undefined);
    },
  };
}

/** Backends of a login on the suite's database (what the pool really holds open), not counting `admin` itself. */
export async function backends(db: LiveDb, user: string): Promise<number> {
  const r = await db.admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND datname = current_database() AND pid <> pg_backend_pid()`, [user]);
  return r.rows[0].n as number;
}
