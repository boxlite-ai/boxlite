/** Console API: the Logs tab, stored log lines merged with the app proxy access log, presented by console-logs.ts. */
import type { Hono } from 'hono';
import { presentLogLines } from '../../console-logs.js';
import { parseSince } from '../../services/logs.js';
import type { ConsoleKit } from './kit.js';

export function consoleLogRoutes(api: Hono, k: ConsoleKit): void {
  const { appOf, envOf } = k;
  const { store } = k.ctx;
  const access = k.ctx.accessLog;

  // ---- logs ------------------------------------------------------------------

  api.get('/apps/:id/logs', (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const since = parseSince(c.req.query('since') || '24h')!;
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 1000) || 1000, 1), 5000);
    const deployment = Number(c.req.query('deployment'));
    const byDeployment = Number.isInteger(deployment) && deployment > 0;
    const lines = store.logs(env.id, { since, limit, ...(byDeployment ? { deployment } : {}) }).map((l) => ({
      id: `l${l.id}`,
      ts: l.ts,
      source: l.source,
      level: l.level,
      line: l.line,
      deployment: l.deployment ?? null,
    }));
    // Visitor requests belong to no deployment.
    const requests = (byDeployment ? [] : access.since(env.id, since, limit)).map((r) => ({
      id: `a${r.id}`,
      ts: r.ts,
      source: 'access',
      level: r.status >= 500 ? 'error' : r.status >= 400 ? 'warn' : 'info',
      line: `${r.method} ${r.path} ${r.status} ${r.ms}ms`,
      deployment: null,
    }));
    const all = presentLogLines([...lines, ...requests], (n) => store.deployment(env.id, n)).slice(0, limit);
    return c.json(all);
  });
}
