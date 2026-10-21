import type { Context } from 'hono';
import type { Ctx } from './ctx.js';
import type { EnvRow } from './db.js';

/**
 * Per-request access log of the app proxy, for the console's Logs (`access`) and Overview metrics.
 * The CP core does not record end-user requests, so this module owns its own table in the CP's
 * sqlite file and hooks in as a middleware in front of the proxy catch-all.
 */

const RING = 20_000;
const TRIM_EVERY = 500;

export interface AccessRow {
  id: number;
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

export class AccessLog {
  private inserts = 0;

  constructor(private readonly ctx: Pick<Ctx, 'store'>) {
    ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS console_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS console_access_env ON console_access(env_id, id);`);
  }

  record(envId: string, row: Omit<AccessRow, 'id'>): void {
    this.ctx.store.run('INSERT INTO console_access (env_id, ts, method, path, status, ms) VALUES (?, ?, ?, ?, ?, ?)', envId, row.ts, row.method, row.path.slice(0, 500), row.status, row.ms);
    if (++this.inserts % TRIM_EVERY === 0) {
      const cut = this.ctx.store.get<{ id: number }>('SELECT id FROM console_access WHERE env_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?', envId, RING);
      if (cut) this.ctx.store.run('DELETE FROM console_access WHERE env_id = ? AND id <= ?', envId, cut.id);
    }
  }

  since(envId: string, sinceIso: string, limit = 1000): AccessRow[] {
    return this.ctx.store
      .all<AccessRow>('SELECT id, ts, method, path, status, ms FROM console_access WHERE env_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?', envId, sinceIso, limit)
      .reverse();
  }

  deleteEnv(envId: string): void {
    this.ctx.store.run('DELETE FROM console_access WHERE env_id = ?', envId);
  }

  /**
   * 24 hourly buckets (oldest first) of requests, 5xx errors and p95 latency, plus the request
   * count of the 24 hours before. null when the env had no traffic in the last 48 hours.
   */
  metrics(envId: string, at = Date.now()): { requests: number[]; errors: number[]; p95Ms: number[]; previousRequests: number } | null {
    const hour = 3_600_000;
    const end = Math.ceil(at / hour) * hour;
    const start = end - 24 * hour;
    const rows = this.ctx.store.all<{ ts: string; status: number; ms: number }>(
      'SELECT ts, status, ms FROM console_access WHERE env_id = ? AND ts >= ?',
      envId,
      new Date(start - 24 * hour).toISOString(),
    );
    if (!rows.length) return null;
    const requests = Array.from({ length: 24 }, () => 0);
    const errors = Array.from({ length: 24 }, () => 0);
    const latencies: number[][] = Array.from({ length: 24 }, () => []);
    let previousRequests = 0;
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (t < start) {
        previousRequests++;
        continue;
      }
      const i = Math.min(23, Math.floor((t - start) / hour));
      requests[i]!++;
      if (r.status >= 500) errors[i]!++;
      latencies[i]!.push(r.ms);
    }
    const p95Ms = latencies.map((l) => {
      if (!l.length) return 0;
      l.sort((a, b) => a - b);
      return l[Math.min(l.length - 1, Math.ceil(l.length * 0.95) - 1)]!;
    });
    return { requests, errors, p95Ms, previousRequests };
  }
}

/** One-time values in query strings (open tickets, sign-in handoff codes, the retired `__key`) are never logged. */
const SCRUBBED_PARAMS = ['t', 'code', '__key', 'state'];

/**
 * Times one request on an env's own origin and logs it against that env. server.ts wraps every
 * app-origin request in it (requests no longer carry the app in their path).
 */
export async function withAccessLog(log: AccessLog, env: EnvRow, c: Context, handle: () => Promise<Response>): Promise<Response> {
  const started = Date.now();
  const res = await handle();
  try {
    const url = new URL(c.req.url);
    for (const k of SCRUBBED_PARAMS) url.searchParams.delete(k);
    const search = url.searchParams.toString();
    log.record(env.id, { ts: new Date(started).toISOString(), method: c.req.method, path: (url.pathname || '/') + (search ? `?${search}` : ''), status: res.status, ms: Date.now() - started });
  } catch (err) {
    console.error(`[console] access log: ${(err as Error).message}`);
  }
  return res;
}
