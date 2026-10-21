// Live check of the SQL endpoint's guard rails against real Neon (Postgres 17): the reader role,
// the READ ONLY transaction, the result caps, and the bypass matrix of test/sql-matrix.ts — once
// through the guard (what the endpoint does) and once raw as the reader (what the role alone
// stops). Creates a throwaway project and deletes it.
// Run: npx tsx scripts/neon-sqlguard-smoke.ts   (needs NEON_API_KEY, NEON_ORG_ID in .env.local)
import pg from 'pg';
import { MAX_RESULT_BYTES, MAX_ROWS, PgAppDatabase, pgConnect, type DbConn } from '../src/appdb.js';
import { loadDotEnvLocal } from '../src/config.js';
import { UpstreamError } from '../src/errors.js';
import { requestJson } from '../src/http.js';
import { HttpNeonClient, withSslmode } from '../src/neon.js';
import { READER_ROLE, classify } from '../src/sqlguard.js';
import { MATRIX, verdict } from '../test/sql-matrix.js';

loadDotEnvLocal();
const neon = new HttpNeonClient(process.env.NEON_API_KEY ?? '', process.env.NEON_ORG_ID ?? '');
// TRACE=1 prints every query, read and error the CP sends.
const trace = process.env.TRACE === '1';
const tracing = async (u: string): Promise<DbConn> => {
  const c = await pgConnect(u);
  const t = (label: string) => (e: unknown) => {
    console.log(`  ${label} ERR ${(e as { code?: string }).code} ${(e as Error).message}`);
    throw e;
  };
  return {
    query: (text, v) => (console.log(`  query ${text.slice(0, 70).replace(/\s+/g, ' ')}`), c.query(text, v).catch(t('query'))),
    cursor: (text, v) => {
      const cur = c.cursor(text, v);
      return { ...cur, read: (n) => cur.read(n).then((r) => (console.log(`  read ${n} → ${r.length}`), r), t('read')), close: () => cur.close().catch(t('close')) };
    },
    end: c.end,
  };
};
const db = new PgAppDatabase(trace ? tracing : pgConnect);
let failures = 0;
let section = 'setup';
const ok = (cond: boolean, what: string) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
};
const errOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; details?: { sqlstate?: string } };
    return `${e.code}${e.details?.sqlstate ? `/${e.details.sqlstate}` : ''}: ${e.message}`;
  }
};
const read = (url: string, sql: string, params?: unknown[]) => db.query(url, classify(sql).statements.map((s) => s.text), { write: false, params });

const p = await neon.createProject(`mc-sqlguard-${Date.now().toString(36)}`);
console.log(`project ${p.projectId} (${p.host})`);
// Whatever happens, the throwaway project goes.
const bail = async (err: unknown) => {
  console.log(`FAIL  crashed in ${section}: ${(err as Error)?.message ?? err}`);
  await neon.deleteProject(p.projectId).catch(() => undefined);
  console.log(`deleted project ${p.projectId} after the crash`);
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void bail(new Error(sig)));
try {
  const url = withSslmode(p.connectionUri);
  // Short-lived owner connections: Neon's proxy drops long-idle ones mid-run.
  const ownerQuery = async (text: string, values?: unknown[]) => {
    const c = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: true } });
    c.on('error', (e) => console.log(`owner connection error: ${e.message}`));
    await c.connect();
    try {
      return await c.query(text, values);
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  const owner = { query: ownerQuery };
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  console.log(`postgres ${version}, owner ${(await owner.query('SELECT current_user')).rows[0].current_user}`);

  // ---- fixture, as a migration would create it -------------------------------------------
  section = 'fixture, as a migration would create it';
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

  // ---- reader role --------------------------------------------------------------------------
  section = 'reader role';
  await db.ensureReader(url); // the migrate step's call
  await db.ensureReader(url); // idempotent
  const role = (await owner.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolreplication FROM pg_roles WHERE rolname = $1`, [READER_ROLE])).rows[0];
  console.log(`reader role: ${JSON.stringify(role)}`);
  ok(role && !role.rolcanlogin && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication, 'boxlite_reader exists, cannot log in, no admin attributes');
  const memberOf = (await owner.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [READER_ROLE])).rows.map((r) => r.rolname);
  console.log(`reader is member of: ${memberOf.join(', ')}`);
  ok(memberOf.length === 1 && memberOf[0] === 'pg_read_all_data', 'reader holds pg_read_all_data only (no pg_signal_backend, no pg_write_all_data)');
  const priv = (await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS create_public, has_database_privilege($1, current_database(), 'CREATE') AS create_db`, [READER_ROLE])).rows[0];
  ok(!priv.create_public && !priv.create_db, `reader has no CREATE on public or the database (${JSON.stringify(priv)})`);

  // ---- reads run as the reader, see everything, change nothing -----------------------------
  section = 'reads run as the reader, see everything, change nothing';
  const who = await read(url, 'SELECT current_user, session_user, current_setting($1), current_setting($2), current_setting($3)', ['transaction_read_only', 'statement_timeout', 'idle_in_transaction_session_timeout']);
  console.log(`read context: ${JSON.stringify(who.rows[0])}`);
  ok(who.rows[0]![0] === READER_ROLE && who.rows[0]![2] === 'on' && who.rows[0]![3] === '15s' && who.rows[0]![4] === '20s', 'reads: current_user boxlite_reader, read-only, 15 s statement / 20 s idle timeouts');
  ok(Number((await read(url, 'SELECT count(*) FROM secrets')).rows[0]![0]) === 2, 'RLS table reads the same as for the owner (BYPASSRLS)');
  const schema = await read(url, "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't'");
  ok(Number(schema.rows[0]![0]) === 2, 'information_schema shows the tables to the reader (schema / table browser work)');

  // ---- result caps ---------------------------------------------------------------------------
  section = 'result caps';
  const big = await read(url, 'SELECT * FROM big');
  ok(big.rows.length === MAX_ROWS && big.truncated, `20 000-row SELECT → ${big.rows.length} rows, truncated=${big.truncated}`);
  const wide = await read(url, 'SELECT * FROM wide');
  const wideBytes = Buffer.byteLength(JSON.stringify(wide.rows));
  ok(wide.truncated && wideBytes <= MAX_RESULT_BYTES, `100 × 200 KB rows → ${wide.rows.length} rows, ${wideBytes} bytes, truncated=${wide.truncated}`);
  const t0 = Date.now();
  const slow = await errOf(read(url, 'SELECT count(*) FROM generate_series(1, 1e12)'));
  ok(!!slow && /statement timeout/.test(slow) && Date.now() - t0 < 30_000, `statement_timeout cancels a long read (${((Date.now() - t0) / 1000).toFixed(1)} s incl. connect) → ${slow}`);

  // ---- role layer on its own (guard bypassed) ---------------------------------------------
  section = 'role layer on its own (guard bypassed)';
  const victim = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: true } });
  victim.on('error', (e) => console.log(`victim connection error: ${e.message}`));
  await victim.connect();
  const ownerPid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const raw = [
    [`SELECT pg_terminate_backend(${ownerPid})`, /permission denied|must be a member/],
    [`SELECT pg_cancel_backend(${ownerPid})`, /permission denied|must be a member/],
    ["SELECT lo_import('/etc/passwd')", /permission denied|read-only/],
    ["SELECT pg_read_file('/etc/hostname')", /permission denied/],
    ["SELECT pg_ls_dir('.')", /permission denied/],
    ["COPY t TO PROGRAM 'id'", /permission denied|read-only|must be superuser|COPY/],
    ['INSERT INTO t VALUES (100, 1)', /read-only transaction/],
    ['CREATE TEMP TABLE x (a int)', /read-only transaction/],
    ['CREATE EXTENSION dblink', /read-only transaction|permission denied/],
    ['SET transaction_read_only = off', /before any query|read-only/],
  ] as const;
  for (const [sql, want] of raw) {
    const e = await errOf(db.query(url, [sql], { write: false }));
    ok(!!e && want.test(e), `role/read-only alone stops ${sql} → ${e}`);
  }
  const alive = (await owner.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [ownerPid])).rows[0].n;
  ok(alive === 1, `the owner session (pid ${ownerPid}) survived the reader’s terminate/cancel attempts`);
  await victim.end().catch(() => undefined);
  for (const sql of ['RESET ROLE', `SET ROLE neondb_owner`, "SELECT set_config('role', 'neondb_owner', true)", "UPDATE pg_settings SET setting = 'neondb_owner' WHERE name = 'role'"]) {
    const e = await errOf(db.query(url, [sql], { write: false }));
    // UPDATE pg_settings is rewritten to SELECT set_config(), but Postgres still applies the read-only check of the UPDATE.
    ok(!!e && (/forbidden: the query changed the role/.test(e) || /read-only transaction/.test(e)), `escape back to the owner (guard bypassed) is stopped: ${sql} → ${e}`);
  }

  // ---- the bypass matrix, against Postgres 17 -------------------------------------------------
  section = 'the bypass matrix, against Postgres 17';
  let guardOk = 0;
  const rawOutcome: Record<string, number> = {};
  const rawRan: string[] = [];
  for (const [sql, want] of MATRIX) {
    const c = classify(sql);
    if (verdict(c) === want) guardOk++;
    else console.log(`FAIL  guard: ${JSON.stringify(sql)} want ${want} got ${verdict(c)}`);
    if (c.syntaxError || !c.statements.length) continue;
    // COPY … STDIN/STDOUT cannot be driven through the cursor protocol; the guard refuses them anyway.
    if (/^\s*copy\b/i.test(sql) && !/program|'\//i.test(sql)) continue;
    if (trace) console.log(`case ${JSON.stringify(sql)}`);
    const e = await errOf(db.query(url, c.statements.map((s) => s.text), { write: false }));
    const outcome = e === null ? 'ran' : /changed the role/.test(e) ? 'caught: role changed' : `stopped by postgres (${/\/(\w+)/.exec(e)?.[1] ?? '?'})`;
    rawOutcome[`${want} → ${outcome}`] = (rawOutcome[`${want} → ${outcome}`] ?? 0) + 1;
    if (want === 'refused' && e === null) rawRan.push(sql);
  }
  ok(guardOk === MATRIX.length, `guard verdicts on ${MATRIX.length} matrix cases: ${guardOk} as expected`);
  console.log('raw (guard bypassed, as reader, read-only) outcomes:');
  for (const [k, n] of Object.entries(rawOutcome).sort()) console.log(`        ${String(n).padStart(3)}  ${k}`);
  console.log(`refused-by-guard cases Postgres alone would have run as the reader (${rawRan.length}):`);
  for (const s of rawRan) console.log(`        ${s.replace(/\s+/g, ' ')}`);

  // ---- writes stay owner, side effects complete -----------------------------------------------
  section = 'writes stay owner, side effects complete';
  const w = await db.query(url, ['UPDATE big SET id = id RETURNING id'], { write: true });
  ok(w.row_count === 20000 && w.rows.length === MAX_ROWS && w.truncated, `write returning 20 000 rows: row_count ${w.row_count}, returned ${w.rows.length}`);
} finally {
  await neon.deleteProject(p.projectId);
  let gone = false;
  try {
    await requestJson('neon', { method: 'GET', url: `https://console.neon.tech/api/v2/projects/${p.projectId}`, headers: { authorization: `Bearer ${process.env.NEON_API_KEY}` }, timeoutMs: 30_000 });
  } catch (err) {
    gone = err instanceof UpstreamError && err.status === 404;
  }
  ok(gone, `deleted project ${p.projectId} (GET → 404)`);
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
