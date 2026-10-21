/**
 * Resource-abuse limits (security review F8). In-process state: the CP is one process, so no
 * shared store is needed. Every limit answers in the contracts' error shape; the HTTP ones answer
 * 429 `rate_limited` with `Retry-After` (CLI exit 6, retryable; contracts §1, §4.1).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { bearer, sha256hex } from './auth.js';
import type { LogLine } from './db.js';

export interface Limits {
  /** POST /sv/v1/logs: lines kept per request; the rest of the batch is dropped (and counted). */
  logLinesPerRequest: number;
  /** Longer lines are cut to this many UTF-8 bytes and get a marker. */
  logLineBytes: number;
  /** Token bucket per env for ingested log lines. */
  logLinesPerSecond: number;
  logBurst: number;
  /** At most one `system` warning line about dropped log lines per env per this window. */
  logDropWarnMs: number;
  /** Concurrent SSE streams (logs --follow, deployment events). */
  sseSubscribersPerEnv: number;
  sseSubscribersPerKey: number;
  sseHeartbeatMs: number;
  /** Deployments waiting (status queued) per env. */
  queuedDeploymentsPerEnv: number;
  /** Concurrent PUT …/uploads/{id}/files/{sha} per App. The CLI uploads 8 at a time. */
  uploadsInFlightPerApp: number;
  /** Token bucket per credential on /v1. */
  apiRequestsPerSecond: number;
  apiBurst: number;
}

export const DEFAULT_LIMITS: Limits = {
  logLinesPerRequest: 500,
  logLineBytes: 8 * 1024,
  logLinesPerSecond: 200,
  logBurst: 2000,
  logDropWarnMs: 60_000,
  sseSubscribersPerEnv: 20,
  sseSubscribersPerKey: 10,
  sseHeartbeatMs: 15_000,
  queuedDeploymentsPerEnv: 5,
  uploadsInFlightPerApp: 16,
  apiRequestsPerSecond: 20,
  apiBurst: 100,
};

export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.at = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
  }

  /** Takes up to `n` tokens; returns how many were granted. */
  take(n = 1): number {
    this.refill();
    const granted = Math.max(0, Math.min(n, Math.floor(this.tokens)));
    this.tokens -= granted;
    return granted;
  }

  /** Seconds until one token is available (at least 1, for Retry-After). */
  retryAfter(): number {
    this.refill();
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000) / 1000);
  }

  full(): boolean {
    this.refill();
    return this.tokens >= this.burst;
  }
}

/** Counts holders per key; `acquire` takes a slot on every key or on none. */
export class Gate {
  private readonly held = new Map<string, number>();

  acquire(keys: [string, number][]): (() => void) | null {
    for (const [k, max] of keys) if ((this.held.get(k) ?? 0) >= max) return null;
    for (const [k] of keys) this.held.set(k, (this.held.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [k] of keys) {
        const n = (this.held.get(k) ?? 1) - 1;
        if (n <= 0) this.held.delete(k);
        else this.held.set(k, n);
      }
    };
  }

  count(key: string): number {
    return this.held.get(key) ?? 0;
  }
}

interface LogState {
  bucket: TokenBucket;
  dropped: number;
  lastWarn: number;
  timer: NodeJS.Timeout | null;
}

export class LimitState {
  readonly gate = new Gate();
  private readonly api = new Map<string, TokenBucket>();
  private readonly logs = new Map<string, LogState>();

  constructor(
    readonly limits: Limits,
    readonly now: () => number = Date.now,
  ) {}

  apiBucket(key: string): TokenBucket {
    let b = this.api.get(key);
    if (!b) {
      // Idle buckets are full again; dropping them bounds memory against random bearer tokens.
      if (this.api.size >= 10_000) for (const [k, v] of this.api) if (v.full()) this.api.delete(k);
      b = new TokenBucket(this.limits.apiRequestsPerSecond, this.limits.apiBurst, this.now);
      this.api.set(key, b);
    }
    return b;
  }

  logState(envId: string): LogState {
    let s = this.logs.get(envId);
    if (!s) {
      s = { bucket: new TokenBucket(this.limits.logLinesPerSecond, this.limits.logBurst, this.now), dropped: 0, lastWarn: -Infinity, timer: null };
      this.logs.set(envId, s);
    }
    return s;
  }
}

const states = new WeakMap<object, LimitState>();

/** Per-ctx limit state (tests may replace it with `setLimits`). */
export function limitsOf(ctx: object): LimitState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = new LimitState(DEFAULT_LIMITS)));
  return s;
}

export function setLimits(ctx: object, limits: Partial<Limits>, now?: () => number): LimitState {
  const s = new LimitState({ ...DEFAULT_LIMITS, ...limits }, now);
  states.set(ctx, s);
  return s;
}

/** Stable id of the request's credential (sha256 of the bearer token), or null without one. */
export function credentialOf(c: Context): string | null {
  const token = bearer(c.req.header('authorization'));
  return token ? sha256hex(token) : null;
}

export function rateLimited(c: Context, message: string, retryAfterSeconds: number, next: string): Response {
  const secs = Math.max(1, Math.ceil(retryAfterSeconds));
  return c.json({ error: { code: 'rate_limited', message, next: next.replace('{s}', String(secs)), retry_after: secs } }, 429, { 'Retry-After': String(secs) });
}

const UPLOAD_PUT = /^\/v1\/apps\/[^/]+\/uploads\/[^/]+\/files\/[^/]+$/;

/**
 * /v1 per-credential token bucket. Upload file PUTs are exempt: they have their own per-App
 * concurrency cap and size caps, and a deploy of a fresh project PUTs one request per file.
 */
export function apiRateLimit(ctx: object): MiddlewareHandler {
  return async (c, next) => {
    const cred = credentialOf(c);
    if (!cred || (c.req.method === 'PUT' && UPLOAD_PUT.test(c.req.path))) return next();
    const s = limitsOf(ctx);
    const bucket = s.apiBucket(cred);
    if (bucket.take(1) < 1) {
      return rateLimited(c, `more than ${s.limits.apiRequestsPerSecond} requests per second (burst ${s.limits.apiBurst}) with this key`, bucket.retryAfter(), 'wait {s} s and retry');
    }
    return next();
  };
}

/** A concurrent SSE slot for this env and credential, or null when either is at its cap. */
export function sseSlot(ctx: object, envId: string, cred: string | null): (() => void) | null {
  const s = limitsOf(ctx);
  const keys: [string, number][] = [[`sse:env:${envId}`, s.limits.sseSubscribersPerEnv]];
  if (cred) keys.push([`sse:key:${cred}`, s.limits.sseSubscribersPerKey]);
  return s.gate.acquire(keys);
}

export function sseBusy(c: Context, ctx: object): Response {
  const s = limitsOf(ctx);
  return rateLimited(c, `too many open streams (at most ${s.limits.sseSubscribersPerEnv} per environment and ${s.limits.sseSubscribersPerKey} per key)`, 5, 'close other `--follow` sessions, or wait {s} s and retry');
}

export function uploadSlot(ctx: object, appId: string): (() => void) | null {
  const s = limitsOf(ctx);
  return s.gate.acquire([[`upload:${appId}`, s.limits.uploadsInFlightPerApp]]);
}

function cutLine(line: string, max: number): string {
  const bytes = Buffer.byteLength(line);
  if (bytes <= max) return line;
  const kept = Buffer.from(line, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
  return `${kept} … [truncated ${bytes - Buffer.byteLength(kept)} bytes]`;
}

/**
 * Applies the per-request cap, line length cap and per-env token bucket to one ingest batch.
 * Lines over budget are dropped; one `system` warning per env per window says how many. A drop
 * that has not been reported yet is reported when the window ends (timer), so a burst followed by
 * silence is still visible.
 */
export function admitLogs(ctx: object, envId: string, lines: LogLine[], record: (lines: LogLine[]) => void): { accepted: LogLine[]; dropped: number } {
  const s = limitsOf(ctx);
  const L = s.limits;
  const st = s.logState(envId);
  const head = lines.slice(0, L.logLinesPerRequest);
  const granted = st.bucket.take(head.length);
  const accepted = head.slice(0, granted).map((l) => ({ ...l, line: cutLine(l.line, L.logLineBytes) }));
  const dropped = lines.length - accepted.length;
  if (accepted.length) record(accepted);
  if (dropped) {
    st.dropped += dropped;
    const flush = () => {
      st.timer = null;
      if (!st.dropped) return;
      const n = st.dropped;
      st.dropped = 0;
      st.lastWarn = s.now();
      record([
        {
          ts: new Date(s.now()).toISOString(),
          source: 'system',
          level: 'error',
          line: `log ingest limit: dropped ${n} line(s) (limits: ${L.logLinesPerRequest} lines per push, ${L.logLinesPerSecond} lines/s, burst ${L.logBurst})`,
          deployment: null,
        },
      ]);
    };
    const since = s.now() - st.lastWarn;
    if (since >= L.logDropWarnMs) flush();
    else if (!st.timer) {
      st.timer = setTimeout(flush, L.logDropWarnMs - since);
      st.timer.unref();
    }
  }
  return { accepted, dropped };
}
