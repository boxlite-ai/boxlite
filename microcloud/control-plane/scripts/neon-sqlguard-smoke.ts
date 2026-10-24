// Live check of the SQL endpoint's guard rails against real Neon (Postgres 17): the reader login
// (Neon API role, dbreader.ts), migration away from a SQL-created reader, schema-only and
// with-data branches, the READ ONLY transaction, the result caps, and the bypass matrix of
// test/sql-matrix.ts — through the guard (what the endpoint does) and raw as the reader (what the
// database alone stops). Creates a throwaway project and deletes it, also on crash or signal.
// Run: npx tsx scripts/neon-sqlguard-smoke.ts   (needs NEON_API_KEY, NEON_ORG_ID in .env.local)
//      SKIP_MATRIX=1 skips the slow raw matrix pass.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MAX_RESULT_BYTES, MAX_ROWS, PgAppDatabase, pgConnect } from '../src/appdb.js';
import { loadDotEnvLocal } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { DbReaders } from '../src/dbreader.js';
import { UpstreamError } from '../src/errors.js';
import { requestJson } from '../src/http.js';
import { HttpNeonClient, withSslmode } from '../src/neon.js';
import { READER_ROLE, classify } from '../src/sqlguard.js';
import { MATRIX, verdict } from '../test/sql-matrix.js';

loadDotEnvLocal();
const neon = new HttpNeonClient(process.env.NEON_API_KEY ?? '', process.env.NEON_ORG_ID ?? '');
let failures = 0;
let section = 'setup';
const ok = (cond: boolean, what: string) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
};
const info = (what: string) => console.log(`INFO  ${what}`);
const errOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: { sqlstate?: string } };
    return `${e.code}${e.details?.sqlstate ? `/${e.details.sqlstate}` : ''}: ${e.message}`;
  }
};
/** Plain SQL on its own short-lived connection (Neon's proxy drops long-idle ones). */
const raw = async (url: string, text: string, values?: unknown[]) => {
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: true } });
  c.on('error', (e) => console.log(`  connection error: ${e.message}`));
  await c.connect();
  try {
    return await c.query(text, values);
  } finally {
    await c.end().catch(() => undefined);
  }
};
const rawErr = (url: string, text: string) => errOf(raw(url, text));

const dir = mkdtempSync(join(tmpdir(), 'mc-sqlguard-'));
const store = new Store(join(dir, 'cp.sqlite'));
const db = new PgAppDatabase();
const readers = new DbReaders({ store, neon, connect: pgConnect });
db.bindReaders(readers);

const p = await neon.createProject(`mc-sqlguard-${Date.now().toString(36)}`);
console.log(`project ${p.projectId} (${p.host})`);
const bail = async (err: unknown) => {
  console.log(`FAIL  crashed in ${section}: ${(err as Error)?.message ?? err}`);
  await neon.deleteProject(p.projectId).catch(() => undefined);
  console.log(`deleted project ${p.projectId} after the crash`);
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void bail(new Error(sig)));

/** Registers a branch as an env of the fake app, the way the CP's store knows it. */
const addEnv = (name: string, branchId: string, url: string) =>
  store.run('INSERT INTO envs (id, app_id, name, created_at, neon_branch_id, db_url, forward_secret) VALUES (?, ?, ?, ?, ?, ?, ?)', `env_${name}`, 'app_smoke', name, now(), branchId, url, 'x');
const branchUrl = async (branchId: string) => withSslmode(await neon.connectionUri(p.projectId, branchId));
const neonBranch = async (name: string, init: 'schema-only' | 'parent-data') => {
  try {
    return { id: (await neon.createBranch(p.projectId, name, p.mainBranchId, init)).branchId, status: 201 };
  } catch (err) {
    return { id: null, status: err instanceof UpstreamError ? err.status : -1, message: (err as Error).message };
  }
};

try {
  const url = withSslmode(p.connectionUri);
  store.run('INSERT INTO apps (id, name, created_at, neon_project_id, neon_main_branch_id) VALUES (?, ?, ?, ?, ?)', 'app_smoke', 'smoke', now(), p.projectId, p.mainBranchId);
  addEnv('main', p.mainBranchId, url);
  console.log(`postgres ${(await raw(url, 'SHOW server_version')).rows[0].server_version}`);

  // ---- fixture, as a migration would create it -------------------------------------------
  section = 'fixture';
  await db.applyMigration(
    url,
    {
      file: '0001_init.sql',
      sha256: 'x',
      sql: `CREATE TABLE t (id int PRIMARY KEY, a int);
            INSERT INTO t SELECT g, g FROM generate_series(1, 10) g;
            CREATE TABLE users (id int PRIMARY KEY, email text);
            CREATE TABLE secrets (id int, owner text, v text);
            ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
            CREATE POLICY own ON secrets USING (owner = current_setting('boxlite.user', true));
            INSERT INTO secrets VALUES (1, 'alice', 's1'), (2, 'bob', 's2');
            CREATE TABLE big AS SELECT g AS id, repeat('x', 1000) AS pad FROM generate_series(1, 20000) g;
            CREATE TABLE wide AS SELECT g AS id, repeat('y', 200000) AS pad FROM generate_series(1, 100) g;`,
    },
    1,
  );

  // ---- migration from the SQL-created reader of the first fix ----------------------------
  section = 'legacy migration';
  await raw(url, `CREATE ROLE ${READER_ROLE} NOLOGIN`);
  await raw(url, `GRANT pg_read_all_data TO ${READER_ROLE}`);
  const blocked = await neonBranch('blocked', 'schema-only');
  ok(blocked.status === 412, `with a SQL-created ${READER_ROLE}, Neon refuses a schema-only branch: ${blocked.status} ${blocked.message ?? ''}`.trim());
  ok((await neon.getRole(p.projectId, p.mainBranchId, READER_ROLE))?.authMethod === 'no_login', 'Neon lists the SQL-created role as no_login');
  await readers.prepareBranching(p.projectId); // what the start-up pass (migrateAll) runs once
  ok((await neon.getRole(p.projectId, p.mainBranchId, READER_ROLE)) === null, 'prepareBranching dropped it');
  await db.ensureReader(url); // what the migrate step runs
  ok((await neon.getRole(p.projectId, p.mainBranchId, READER_ROLE))?.authMethod === 'password', 'ensureReader re-created it through the Neon API (password login)');
  await db.ensureReader(url); // idempotent
  ok(store.get('SELECT 1 AS ok FROM db_readers WHERE project_id = ? AND branch_id = ?', p.projectId, p.mainBranchId) !== undefined, 'password cached in the CP store');

  // ---- what the API reader is -------------------------------------------------------------
  section = 'reader role';
  const role = (await raw(url, `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolconfig FROM pg_roles WHERE rolname = $1`, [READER_ROLE])).rows[0];
  const memberOf = (await raw(url, `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY 1`, [READER_ROLE])).rows.map((r) => r.rolname);
  info(`reader attributes ${JSON.stringify(role)}, member of ${memberOf.join(', ')}`);
  ok(!role.rolsuper && memberOf.includes('pg_read_all_data'), 'reader: not superuser, holds pg_read_all_data');
  ok((role.rolconfig ?? []).includes('default_transaction_read_only=on'), 'reader defaults to read-only transactions (role setting)');
  info(`Neon makes every API role a member of neon_superuser (CREATEROLE/CREATEDB/BYPASSRLS, pg_signal_backend …); the owner cannot revoke it`);

  // ---- reads log in as the reader, see everything, change nothing -------------------------
  section = 'reads';
  const who = await db.query(url, ['SELECT current_user, session_user, current_setting($1), current_setting($2), current_setting($3)'], { write: false, params: ['transaction_read_only', 'statement_timeout', 'idle_in_transaction_session_timeout'] });
  info(`read context ${JSON.stringify(who.rows[0])}`);
  ok(who.rows[0]![0] === READER_ROLE && who.rows[0]![1] === READER_ROLE && who.rows[0]![2] === 'on' && who.rows[0]![3] === '15s' && who.rows[0]![4] === '20s', 'reads: session_user and current_user are boxlite_reader, read-only, 15 s statement / 20 s idle timeouts');
  ok(Number((await db.query(url, ['SELECT count(*) FROM secrets'], { write: false })).rows[0]![0]) === 2, 'RLS table reads the same as for the owner');
  ok(Number((await db.query(url, ["SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't'"], { write: false })).rows[0]![0]) === 2, 'information_schema shows the tables (schema / table browser work)');

  // ---- escalation (guard bypassed: raw statements as the reader) --------------------------
  section = 'escalation';
  for (const sql of ['RESET ROLE', 'SET ROLE neondb_owner', "SELECT set_config('role', 'neondb_owner', false)", 'SET SESSION AUTHORIZATION neondb_owner', 'RESET SESSION AUTHORIZATION']) {
    const e = await errOf(db.query(url, [sql, 'SELECT current_user'], { write: false }));
    let user: unknown = null;
    if (e === null) user = (await db.query(url, [sql, 'SELECT current_user'], { write: false })).rows[0]![0];
    ok(e !== null ? /permission denied/.test(e) : user === READER_ROLE, `${sql} → ${e ?? `ran, current_user still ${user}`}`);
    ok(verdict(classify(sql)) === 'refused', `  and the guard refuses ${sql}`);
  }
  const plainWrite = await rawErr(await readers.urlFor(url), 'INSERT INTO t VALUES (100, 1)');
  ok(!!plainWrite && /read-only transaction/.test(plainWrite), `a plain reader session (no BEGIN READ ONLY) still cannot write: ${plainWrite}`);
  const reEnable = await errOf(db.query(url, ['SET transaction_read_only = off'], { write: false }));
  ok(!!reEnable && /before any query/.test(reEnable), `read-write cannot be re-enabled inside the transaction: ${reEnable}`);

  // ---- what the role alone does not stop (the guard does) ---------------------------------
  section = 'role limits';
  const victimUrl = url.replace(/[?&]sslmode=[^&]*/, '');
  const victim = new pg.Client({ connectionString: victimUrl, ssl: { rejectUnauthorized: true } });
  victim.on('error', () => undefined);
  await victim.connect();
  const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  for (const sql of [`SELECT pg_cancel_backend(${pid})`, "SELECT pg_read_file('/etc/hostname')", "SELECT lo_import('/etc/passwd')", "COPY t TO PROGRAM 'id'", 'CREATE EXTENSION dblink', 'CREATE TEMP TABLE x (a int)']) {
    const e = await errOf(db.query(url, [sql], { write: false }));
    info(`as the reader, guard bypassed: ${sql} → ${e ?? 'RAN'}`);
    ok(verdict(classify(sql)) === 'refused' || verdict(classify(sql)) === 'ddl', `  the endpoint refuses it before the database (${verdict(classify(sql))})`);
  }
  await victim.end().catch(() => undefined);

  // ---- result caps --------------------------------------------------------------------------
  section = 'result caps';
  const big = await db.query(url, ['SELECT * FROM big'], { write: false });
  ok(big.rows.length === MAX_ROWS && big.truncated, `20 000-row SELECT → ${big.rows.length} rows, truncated=${big.truncated}`);
  const wide = await db.query(url, ['SELECT * FROM wide'], { write: false });
  const wideBytes = Buffer.byteLength(JSON.stringify(wide.rows));
  ok(wide.truncated && wideBytes <= MAX_RESULT_BYTES, `100 × 200 KB rows → ${wide.rows.length} rows, ${wideBytes} bytes, truncated=${wide.truncated}`);
  const t0 = Date.now();
  const slow = await errOf(db.query(url, ['SELECT count(*) FROM generate_series(1, 1e12)'], { write: false }));
  ok(!!slow && /statement timeout/.test(slow), `statement_timeout cancels a long read (${((Date.now() - t0) / 1000).toFixed(1)} s incl. connect) → ${slow}`);

  // ---- branches ------------------------------------------------------------------------------
  section = 'branches';
  const mainPw = store.get<{ password: string }>('SELECT password FROM db_readers WHERE branch_id = ?', p.mainBranchId)!.password;
  for (const [name, init] of [['staging', 'schema-only'], ['copy', 'parent-data']] as const) {
    const b = await neonBranch(name, init);
    ok(b.status === 201, `${init} branch with the API reader present → ${b.status}`);
    if (!b.id) continue;
    const bUrl = await branchUrl(b.id);
    addEnv(name, b.id, bUrl);
    const rows = await db.query(bUrl, ['SELECT current_user, count(*) FROM t'], { write: false });
    const pw = store.get<{ password: string }>('SELECT password FROM db_readers WHERE branch_id = ?', b.id)?.password;
    ok(rows.rows[0]![0] === READER_ROLE, `read on the ${init} branch as ${rows.rows[0]![0]}: t has ${rows.rows[0]![1]} row(s)`);
    info(`${init} branch: Neon lists the reader → ${(await neon.getRole(p.projectId, b.id, READER_ROLE))?.authMethod ?? 'absent'}; password per branch fetched, same as main: ${pw === mainPw}`);
  }

  // ---- the bypass matrix, against Postgres 17 -------------------------------------------------
  section = 'matrix';
  let guardOk = 0;
  for (const [sql, want] of MATRIX) if (verdict(classify(sql)) === want) guardOk++;
  ok(guardOk === MATRIX.length, `guard verdicts on ${MATRIX.length} matrix cases: ${guardOk} as expected`);
  if (process.env.SKIP_MATRIX !== '1') {
    const outcome: Record<string, number> = {};
    const ran: string[] = [];
    for (const [sql, want] of MATRIX) {
      const c = classify(sql);
      if (c.syntaxError || !c.statements.length) continue;
      if (/^\s*copy\b/i.test(sql) && !/program|'\//i.test(sql)) continue; // STDIN/STDOUT cannot go through the cursor protocol
      if (/pg_terminate_backend/.test(sql)) continue; // would end this script's own connections (neon_superuser)
      const e = await errOf(db.query(url, c.statements.map((s) => s.text), { write: false }));
      const k = `${want} → ${e === null ? 'ran' : `stopped by postgres (${/\/(\w+)/.exec(e)?.[1] ?? '?'})`}`;
      outcome[k] = (outcome[k] ?? 0) + 1;
      if (want === 'refused' && e === null) ran.push(sql);
    }
    console.log('raw (guard bypassed, as the reader, read-only) outcomes:');
    for (const [k, n] of Object.entries(outcome).sort()) console.log(`        ${String(n).padStart(3)}  ${k}`);
    console.log(`refused-by-guard cases Postgres alone would have run as the reader (${ran.length}):`);
    for (const s of ran) console.log(`        ${s.replace(/\s+/g, ' ')}`);
  }

  // ---- writes stay owner, side effects complete -----------------------------------------------
  section = 'writes';
  const w = await db.query(url, ['UPDATE big SET id = id RETURNING id'], { write: true });
  ok(w.row_count === 20000 && w.rows.length === MAX_ROWS && w.truncated, `write returning 20 000 rows: row_count ${w.row_count}, returned ${w.rows.length}`);
  ok((await raw(url, 'SELECT current_user AS u')).rows[0].u === 'neondb_owner', 'writes connect as the owner');
} finally {
  await neon.deleteProject(p.projectId);
  let gone = false;
  try {
    await requestJson('neon', { method: 'GET', url: `https://console.neon.tech/api/v2/projects/${p.projectId}`, headers: { authorization: `Bearer ${process.env.NEON_API_KEY}` }, timeoutMs: 30_000 });
  } catch (err) {
    gone = err instanceof UpstreamError && err.status === 404;
  }
  ok(gone, `deleted project ${p.projectId} (GET → 404)`);
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
