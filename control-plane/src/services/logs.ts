import type { Deployment, LogLine, Store } from '../db.js';

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

/**
 * A deployment's log lines, oldest first, at most `limit`. CP lines carry the deployment number,
 * supervisor lines the release it was told to run; for apply and rollback those differ, so the
 * release's lines inside the deployment's time window are merged in.
 */
export function deploymentLogs(store: Pick<Store, 'logs'>, envId: string, d: Deployment, limit: number): LogLine[] {
  const own = store.logs(envId, { deployment: d.number, limit });
  const release =
    d.release && d.release !== d.number ? store.logs(envId, { deployment: d.release, since: d.started_at ?? d.created_at, limit }).filter((l) => !d.finished_at || l.ts <= d.finished_at) : [];
  return [...own, ...release].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(-limit);
}

/** `<ts> [<source>] <line>`: the log tail of a deployment, and what the failure classifier reads. */
export const formatLogLine = (l: LogLine) => `${l.ts} [${l.source}] ${l.line}`;
