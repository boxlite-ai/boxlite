import { Hono } from 'hono';
import { z } from 'zod';
import { newId, type Vars } from '../auth.js';
import type { EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { MAX_ROWS } from '../appdb.js';
import { classify } from '../sqlguard.js';
import { body, envOf } from './util.js';

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function dbUrl(env: EnvRow): string {
  if (!env.db_url) throw fail('not_found', `env "${env.name}" has no database`, 'add [database] to boxlite.toml and run `boxlite-app apply`');
  return env.db_url;
}

export function dbRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  const { store, appdb } = ctx;

  r.get('/envs/:env/db', async (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    if (!env.db_url || !env.neon_branch_id) return c.json({ status: 'none' });
    const u = new URL(env.db_url);
    let size: number | null = null;
    let status = 'ready';
    try {
      size = (await ctx.neon.getBranch(app.neon_project_id!, env.neon_branch_id)).logicalSizeBytes;
    } catch {
      status = 'unknown';
    }
    return c.json({ status, host: u.hostname, database: u.pathname.slice(1), user: decodeURIComponent(u.username), branch: env.neon_branch_id, size_bytes: size });
  });

  r.get('/envs/:env/db/schema', async (c) => {
    const env = envOf(ctx, c);
    const res = await appdb.query(
      dbUrl(env),
      [
        `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_name, c.ordinal_position`,
      ],
      { write: false },
    );
    const tables = new Map<string, { name: string; columns: unknown[] }>();
    for (const [table, column, type, nullable, def] of res.rows as string[][]) {
      if (!tables.has(table!)) tables.set(table!, { name: table!, columns: [] });
      tables.get(table!)!.columns.push({ name: column, type, nullable: nullable === 'YES', default: def });
    }
    return c.json({ tables: [...tables.values()] });
  });

  r.get('/envs/:env/db/schema/:table', async (c) => {
    const env = envOf(ctx, c);
    const table = c.req.param('table');
    const url = dbUrl(env);
    const cols = await appdb.query(
      url,
      [`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`],
      { write: false, params: [table] },
    );
    if (!cols.rows.length) throw fail('not_found', `no table public.${table}`);
    const idx = await appdb.query(url, [`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`], { write: false, params: [table] });
    const cons = await appdb.query(
      url,
      [`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = to_regclass('public.' || quote_ident($1)) ORDER BY conname`],
      { write: false, params: [table] },
    );
    const est = await appdb.query(url, [`SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass('public.' || quote_ident($1))`], { write: false, params: [table] });
    return c.json({
      name: table,
      columns: cols.rows.map(([name, type, nullable, def]) => ({ name, type, nullable: nullable === 'YES', default: def })),
      indexes: idx.rows.map(([name, def]) => ({ name, definition: def })),
      constraints: cons.rows.map(([name, def]) => ({ name, definition: def })),
      row_estimate: est.rows[0]?.[0] !== undefined ? Number(est.rows[0][0]) : null,
    });
  });

  r.get('/envs/:env/db/rows/:table', async (c) => {
    const env = envOf(ctx, c);
    const table = c.req.param('table');
    const url = dbUrl(env);
    const where = c.req.query('where')?.trim() || '';
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), MAX_ROWS);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const exists = await appdb.query(url, [`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`], { write: false, params: [table] });
    if (!exists.rows.length) throw fail('not_found', `no table public.${table}`);
    const text = `SELECT * FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''} LIMIT $1 OFFSET $2`;
    if (where) {
      // Classify the composed statement, so `where` cannot close it, add another or call a denied function.
      const cls = classify(text);
      if (cls.syntaxError) throw fail('invalid_request', `\`where\` is not a valid SQL expression: ${cls.syntaxError.message}`);
      if (cls.refused) throw fail('forbidden', cls.refused);
      if (cls.statements.length !== 1 || cls.statements[0]!.keyword !== 'SELECT' || cls.statements[0]!.kind !== 'read') throw fail('invalid_request', '`where` must be a single SQL expression');
    }
    // Reader role + read-only transaction + extended protocol: `where` can only ever read.
    const res = await appdb.query(url, [text], { write: false, params: [limit, offset] });
    return c.json({ ...res, limit, offset });
  });

  r.post('/envs/:env/db/sql', async (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    const b = await body(c, z.object({ query: z.string().min(1).max(200_000), write: z.boolean().optional(), explain: z.boolean().optional() }));
    const cls = classify(b.query);
    if (cls.syntaxError) throw fail('sql_error', cls.syntaxError.message, undefined, { sqlstate: '42601', position: cls.syntaxError.position });
    if (cls.refused) throw fail('forbidden', cls.refused);
    if (cls.ddl) {
      if (env.name === 'main') {
        const kw = [...new Set(cls.statements.filter((s) => s.ddl).map((s) => s.keyword))].join(', ');
        throw fail('forbidden', `schema changes (DDL: ${kw}) are not allowed on main through SQL`, 'add a file under migrations/ and run `boxlite-app apply`');
      }
      if (!b.write) throw fail('forbidden', 'DDL (including DO, CALL and functions) needs write:true', 'pass --write (allowed on non-main environments only)');
    }
    let statements = cls.statements.map((s) => s.text);
    if (b.explain) {
      if (statements.length !== 1) throw fail('invalid_request', 'explain takes exactly one statement');
      statements = [`EXPLAIN (FORMAT TEXT) ${statements[0]}`];
    }
    const res = await appdb.query(dbUrl(env), statements, { write: !!b.write });
    if (b.write) store.recordActivity(app.id, env.name, c.get('actor'), 'db.sql.write', { statements: cls.statements.map((s) => s.keyword) });
    return c.json(res);
  });

  r.get('/envs/:env/db/migrations', async (c) => {
    const env = envOf(ctx, c);
    const latest = store.deploymentsWhere("env_id = ? AND kind IN ('deploy', 'apply') ORDER BY number DESC LIMIT 1", env.id)[0];
    const files = latest?.request.resolved_migrations ?? latest?.request.migrations?.map((m) => ({ file: m.file, sha256: m.sha256 })) ?? [];
    const applied = env.db_url ? await appdb.listApplied(env.db_url) : [];
    const done = new Map(applied.map((a) => [a.file, a]));
    const out: { file: string; status: 'applied' | 'pending' | 'changed'; deployment?: number | null; applied_at?: string }[] = [];
    for (const f of files) {
      const a = done.get(f.file);
      if (!a) out.push({ file: f.file, status: 'pending' });
      else out.push({ file: f.file, status: a.sha256 === f.sha256 ? 'applied' : 'changed', deployment: a.deployment, applied_at: a.applied_at });
      done.delete(f.file);
    }
    for (const a of done.values()) out.push({ file: a.file, status: 'applied', deployment: a.deployment, applied_at: a.applied_at });
    out.sort((x, y) => x.file.localeCompare(y.file));
    return c.json(out);
  });

  /** A DB snapshot is a named point in time; Neon's history makes it restorable (within retention). */
  r.get('/envs/:env/db/snapshots', (c) => {
    const env = envOf(ctx, c);
    return c.json(store.all('SELECT id, message, ts, ts AS created_at, by FROM db_snapshots WHERE env_id = ? ORDER BY ts DESC', env.id));
  });

  r.post('/envs/:env/db/snapshots', async (c) => {
    const env = envOf(ctx, c);
    dbUrl(env);
    const b = await body(c, z.object({ message: z.string().max(500).optional() }));
    const ts = now();
    const snap = { id: newId('dbs'), message: b.message ?? null, ts, created_at: ts, by: c.get('actor') };
    store.run('INSERT INTO db_snapshots (id, env_id, message, ts, by) VALUES (?, ?, ?, ?, ?)', snap.id, env.id, snap.message, snap.ts, snap.by);
    return c.json(snap, 201);
  });

  r.post('/envs/:env/db/restore', async (c) => {
    const app = c.get('app');
    const env = envOf(ctx, c);
    dbUrl(env);
    const b = await body(c, z.object({ to: z.string().optional(), snapshot: z.string().optional() }));
    let ts: string;
    if (b.snapshot) {
      const s = store.get<{ ts: string }>('SELECT ts FROM db_snapshots WHERE id = ? AND env_id = ?', b.snapshot, env.id);
      if (!s) throw fail('not_found', `no snapshot ${b.snapshot}`);
      ts = s.ts;
    } else if (b.to) {
      const t = Date.parse(b.to);
      if (Number.isNaN(t)) throw fail('invalid_request', '`to` must be an ISO 8601 timestamp');
      if (t > Date.now()) throw fail('invalid_request', '`to` is in the future');
      ts = new Date(t).toISOString();
    } else {
      throw fail('invalid_request', 'pass `to` (ISO 8601) or `snapshot`');
    }
    const preserved = `${env.name}-before-restore-${Date.now()}`;
    await ctx.neon.restoreBranch(app.neon_project_id!, env.neon_branch_id!, ts, preserved);
    return c.json({ restored_to: ts, preserved_as: preserved });
  });

  return r;
}
