/** Console API: the Logs tab, stored log lines merged with the app proxy access log, presented by console-logs.ts. */
import type { Hono } from 'hono'
import { presentLogLines } from '../../console-logs'
import { linesOfDeployment, parseSince } from '../../services/logs'
import type { ConsoleKit } from './kit'

export function consoleLogRoutes(api: Hono, k: ConsoleKit): void {
  const { appOf, envOf } = k
  const { store } = k.ctx
  const access = k.ctx.accessLog

  // ---- logs ------------------------------------------------------------------

  api.get('/apps/:id/logs', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const since = parseSince(c.req.query('since') || '24h')!
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 1000) || 1000, 1), 5000)
    const n = Number(c.req.query('deployment'))
    const byDeployment = Number.isInteger(n) && n > 0
    const deployment = byDeployment ? await store.deployment(env.id, n) : undefined
    const stored = byDeployment
      ? deployment
        ? await linesOfDeployment(store, env.id, deployment, { since, limit })
        : []
      : await store.logs(env.id, { since, limit })
    const lines = stored.map((l) => ({
      id: `l${l.id}`,
      ts: l.ts,
      source: l.source,
      level: l.level,
      line: l.line,
      deployment: l.deployment ?? null,
    }))
    // Visitor requests belong to no deployment.
    const requests = (byDeployment ? [] : await access.since(env.id, since, limit)).map((r) => ({
      id: `a${r.id}`,
      ts: r.ts,
      source: 'access',
      level: r.status >= 500 ? 'error' : r.status >= 400 ? 'warn' : 'info',
      line: `${r.method} ${r.path} ${r.status} ${r.ms}ms`,
      deployment: null,
    }))
    const all = (await presentLogLines([...lines, ...requests], async (n) => await store.deployment(env.id, n))).slice(
      0,
      limit,
    )
    return c.json(all)
  })
}
