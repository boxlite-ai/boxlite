/** Console API: the Database tab, overview with table counts, the row browser, the SQL console, restore. */
import type { Hono } from 'hono';
import { z } from 'zod';
import { actorLabel } from '../../console-activity.js';
import type { AppRow, EnvRow } from '../../db.js';
import { quoteIdent, quoteLiteral, TABLES_QUERY } from '../../services/db.js';
import { HttpError } from '../../errors.js';
import type { ConsoleKit } from './kit.js';

/** Exact row counts of the given tables in one statement (the SQL guard refuses dynamic SQL, so it is built here). */
const countsQuery = (tables: string[]) => tables.map((t) => `SELECT ${quoteLiteral(t)}, count(*) FROM public.${quoteIdent(t)}`).join(' UNION ALL ');

/** Neon free plan: point-in-time restore reaches 6 hours back. */
const RESTORE_WINDOW_HOURS = 6;

/** JSON-safe cells: dates and json columns would otherwise render as [object Object]. */
function cells(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map((v) => (v === null || typeof v !== 'object' ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v))));
}

export function consoleDatabaseRoutes(api: Hono, k: ConsoleKit): void {
  const { cp, raw, appOf, envOf, v1, json } = k;

  // ---- database -------------------------------------------------------------------

  async function tableCounts(app: AppRow, env: EnvRow): Promise<{ schema: string; name: string; rows: number }[]> {
    const names = (await cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: TABLES_QUERY })).rows.map(([name]) => String(name));
    if (!names.length) return [];
    const counts = await cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: countsQuery(names) });
    const byName = new Map(counts.rows.map(([name, n]) => [String(name), Number(n)]));
    return names.map((name) => ({ schema: 'public', name, rows: byName.get(name) ?? 0 }));
  }

  api.get('/apps/:id/database', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    if (!env.db_url) return c.json({ status: 'none' });
    // Each call opens its own connection (Neon), so they run side by side.
    const [metaResult, tables, migrations, backups] = await Promise.allSettled([
      cp<{ status: string; host?: string; database?: string; user?: string; branch?: string; size_bytes?: number | null }>('GET', `${v1(app, env)}/db`),
      tableCounts(app, env),
      cp<{ file: string; status: string; deployment?: number | null; applied_at?: string }[]>('GET', `${v1(app, env)}/db/migrations`),
      cp<{ id: string; message: string | null; ts: string; by: string }[]>('GET', `${v1(app, env)}/db/snapshots`),
    ]);
    const errors = [metaResult, tables, migrations, backups].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as Error).message);
    const meta = metaResult.status === 'fulfilled' ? metaResult.value : { status: 'unknown' };
    if (meta.status === 'none') return c.json({ status: 'none' });
    return c.json({
      status: meta.status,
      engine: 'Postgres (Neon)',
      host: meta.host,
      name: meta.database,
      user: meta.user,
      branch: meta.branch,
      sizeBytes: meta.size_bytes ?? null,
      tables: tables.status === 'fulfilled' ? tables.value : null,
      migrations: migrations.status === 'fulfilled' ? migrations.value : null,
      backups: backups.status === 'fulfilled' ? backups.value.map((b) => ({ ...b, by: actorLabel(b.by) })) : null,
      restoreWindowHours: RESTORE_WINDOW_HOURS,
      errors,
    });
  });

  api.get('/apps/:id/database/rows/:table', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const table = c.req.param('table');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const search = (c.req.query('search') ?? '').trim();
    // Whole-row text match; the literal is escaped for both SQL and LIKE.
    const where = search ? `${quoteIdent(table)}::text ILIKE '%${search.replace(/[\\%_]/g, '\\$&').replace(/'/g, "''")}%'` : '';
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(where ? { where } : {}) });
    // Each call opens its own database connection, so run them side by side.
    const [page, count, types] = await Promise.all([
      cp<{ columns: string[]; rows: unknown[][] }>('GET', `${v1(app, env)}/db/rows/${encodeURIComponent(table)}?${q}`),
      cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: `SELECT count(*) FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}` }),
      cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, {
        query: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${quoteLiteral(table)}`,
      }),
    ]);
    const typeOf = new Map(types.rows.map(([name, type]) => [String(name), String(type)]));
    return c.json({ columns: page.columns, types: page.columns.map((col) => typeOf.get(col) ?? null), rows: cells(page.rows), total: Number(count.rows[0]?.[0] ?? 0), limit, offset });
  });

  api.post('/apps/:id/sql', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ query: z.string().min(1), write: z.boolean().optional(), explain: z.boolean().optional() }));
    const res = await cp<{ columns: string[]; rows: unknown[][]; row_count: number; elapsed_ms: number; truncated: boolean }>('POST', `${v1(app, env)}/db/sql`, b);
    return c.json({ ...res, rows: cells(res.rows) });
  });

  /**
   * Downloads, streamed from the CLI's /v1 export (activity `db.export`, actor console): Tables →
   * Export CSV (`?table=`), Connection → Download dump (`?format=sql`).
   */
  api.get('/apps/:id/database/export', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const q = new URLSearchParams();
    for (const key of ['table', 'format']) {
      const v = c.req.query(key);
      if (v) q.set(key, v);
    }
    const res = await raw('GET', `${v1(app, env)}/db/export?${q}`);
    if (!res.ok) {
      const e = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; next?: string } }).error ?? {};
      throw new HttpError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.next);
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    for (const h of ['content-type', 'content-disposition']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    return new Response(res.body, { headers });
  });

  api.post('/apps/:id/database/restore', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ snapshot: z.string().optional(), to: z.string().optional() }));
    return c.json(await cp('POST', `${v1(app, env)}/db/restore`, b));
  });
}
