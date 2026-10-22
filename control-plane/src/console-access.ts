import type { Context } from 'hono';
import type { Ctx } from './ctx.js';
import type { EnvRow } from './db.js';

/**
 * Per-request access log of the app proxy, for the console's Logs (`access`) and Overview metrics.
 * Table `console_access` (db.ts migration 7) is keyed to its env, so env deletion and app purge
 * remove the rows. server.ts wraps every app-origin request in `withAccessLog`.
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

/** The Overview's last 24 hours, hourly buckets oldest first. */
export interface ConsoleMetrics {
  requests: number[];
  errors: number[];
  /** null for an hour without requests: there is no latency to report. */
  p95Ms: (number | null)[];
  activeUsers: number[];
  previousRequests: number;
}

export class AccessLog {
  private inserts = 0;

  constructor(private readonly ctx: Pick<Ctx, 'store'>) {}

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

  /**
   * 24 hourly buckets (oldest first) of requests, 5xx errors, p95 latency (null for an hour without
   * requests) and signed-in users, plus the request count of the 24 hours before. null when the env
   * had neither traffic in the last 48 hours nor a signed-in user in the last 24.
   */
  metrics(envId: string, at = Date.now()): ConsoleMetrics | null {
    const hour = 3_600_000;
    const end = Math.ceil(at / hour) * hour;
    const start = end - 24 * hour;
    const rows = this.ctx.store.all<{ ts: string; status: number; ms: number }>(
      'SELECT ts, status, ms FROM console_access WHERE env_id = ? AND ts >= ?',
      envId,
      new Date(start - 24 * hour).toISOString(),
    );
    const activeUsers = this.signedInUsers(envId, start, hour);
    if (!rows.length && !activeUsers.some((n) => n > 0)) return null;
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
      if (!l.length) return null;
      l.sort((a, b) => a - b);
      return l[Math.min(l.length - 1, Math.ceil(l.length * 0.95) - 1)]!;
    });
    return { requests, errors, p95Ms, activeUsers, previousRequests };
  }

  /**
   * Distinct end users with a session alive at some point of each hour (app_sessions: from its
   * creation until it was revoked or expired), 24 buckets from `start`.
   */
  private signedInUsers(envId: string, start: number, hour: number): number[] {
    const end = start + 24 * hour;
    const sessions = this.ctx.store.all<{ user_id: string; created_at: string; expires_at: string; revoked_at: string | null }>(
      'SELECT user_id, created_at, expires_at, revoked_at FROM app_sessions WHERE env_id = ? AND created_at < ? AND COALESCE(revoked_at, expires_at) > ?',
      envId,
      new Date(end).toISOString(),
      new Date(start).toISOString(),
    );
    const users: Set<string>[] = Array.from({ length: 24 }, () => new Set());
    for (const s of sessions) {
      const from = Date.parse(s.created_at);
      const until = Math.min(Date.parse(s.expires_at), s.revoked_at ? Date.parse(s.revoked_at) : Infinity);
      const first = Math.max(0, Math.floor((from - start) / hour));
      const last = Math.min(23, Math.floor((until - start) / hour));
      for (let i = first; i <= last; i++) users[i]!.add(s.user_id);
    }
    return users.map((u) => u.size);
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
