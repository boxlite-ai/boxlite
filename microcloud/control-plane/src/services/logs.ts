/** Log levels, a deployment's log lines, and `since` parsing: shared by the CLI log routes and the console. */
import type { Deployment, LogLine, Store } from '../db.js';
import { fail } from '../errors.js';

/**
 * Log levels. Stored lines keep the level their writer sent (the supervisor sends `info`/`error`,
 * the CP's own writers also `warn`, app frameworks `warning`, `fatal`, …); every reader that
 * speaks the three levels of the console and `logs/search` maps them here, so a `warn` line is a
 * warning everywhere.
 */
export type LogLevel = 'error' | 'warn' | 'info';

const ERROR_LEVELS = ['error', 'err', 'fatal', 'critical', 'crit', 'panic', 'alert', 'emerg'];
const WARN_LEVELS = ['warn', 'warning'];

export function logLevel(stored: string | null | undefined): LogLevel {
  const l = (stored ?? '').toLowerCase();
  if (ERROR_LEVELS.includes(l)) return 'error';
  if (WARN_LEVELS.includes(l)) return 'warn';
  return 'info';
}

/** Stored levels (lower-cased) that are at least `min`: what `level=warn` / `level=error` filters on. */
export function storedLevelsAtLeast(min: 'warn' | 'error'): string[] {
  return min === 'error' ? [...ERROR_LEVELS] : [...WARN_LEVELS, ...ERROR_LEVELS];
}

/** Lines a little after a deployment finished still belong to it: the settle window, the first requests. */
const AFTER_FINISH_MS = 30_000;

/**
 * A deployment's own lines: everything tagged with it or (for an apply or rollback) with the
 * release it started, from its start until shortly after it finished. The release keeps logging
 * under the same number for as long as it runs; that is runtime output, read in Logs.
 */
export function deploymentLogs(store: Pick<Store, 'logs'>, envId: string, d: Deployment, limit: number): LogLine[] {
  const until = d.finished_at ? new Date(Date.parse(d.finished_at) + AFTER_FINISH_MS).toISOString() : undefined;
  const own = store.logs(envId, { deployment: d.number, ...(until ? { until } : {}), limit });
  const release =
    d.release && d.release !== d.number ? store.logs(envId, { deployment: d.release, since: d.started_at ?? d.created_at, ...(until ? { until } : {}), limit }) : [];
  return [...own, ...release].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(-limit);
}

/**
 * What the Logs tab shows for one deployment (`?deployment=N`): every line tagged with it and, for
 * an apply or rollback, the output of the release it restarted, from its start until a later
 * deployment went live. Unlike deploymentLogs this keeps the runtime output, not just the rollout:
 * the process an apply restarts logs under its release's number, not the apply's.
 */
export function linesOfDeployment(store: Pick<Store, 'logs' | 'deploymentsWhere'>, envId: string, d: Deployment, opts: { since: string; limit: number }): LogLine[] {
  const own = store.logs(envId, { deployment: d.number, since: opts.since, limit: opts.limit });
  if (!d.release || d.release === d.number) return own;
  const next = store.deploymentsWhere('env_id = ? AND number > ? AND live_at IS NOT NULL ORDER BY number LIMIT 1', envId, d.number)[0];
  const start = d.started_at ?? d.created_at;
  const until = next ? (next.started_at ?? next.created_at) : undefined;
  const release = store.logs(envId, { deployment: d.release, since: start > opts.since ? start : opts.since, ...(until ? { until } : {}), limit: opts.limit });
  return [...own, ...release].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(-opts.limit);
}

/** `<ts> [<source>] <line>`: the log tail of a deployment, and what the failure classifier reads. */
export const formatLogLine = (l: LogLine) => `${l.ts} [${l.source}] ${l.line}`;

/** `since` is an ISO timestamp or a duration back from now: 90s, 30m, 1h, 2d. */
export function parseSince(v: string | undefined, at = Date.now()): string | undefined {
  if (!v) return undefined;
  const d = /^(\d+)([smhd])$/.exec(v.trim());
  if (d) return new Date(at - Number(d[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[d[2] as 's' | 'm' | 'h' | 'd']).toISOString();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw fail('invalid_request', 'since must be an ISO 8601 timestamp or a duration like 30m, 1h, 2d');
  return new Date(t).toISOString();
}
