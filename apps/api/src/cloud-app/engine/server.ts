import { principalStorage, type PlatformPrincipal } from './platform-principal'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { requireAdmin, requireApp, type Vars } from './auth'
import { apiRateLimit } from './limits'
import type { Config } from './config'
import { DEFAULT_TIMING, type Ctx, type Deps, type Timing } from './ctx'
import { Store } from './db'
import { HttpError, UpstreamError } from './errors'
import { EventBus } from './events'
import { mountEndUserAuth } from './enduser/oauth-flow'
import { Orchestrator } from './orchestrator'
import { AccessLog } from './console-access'
import { Resources } from './resources'
import { adminSecretRoutes, appRoutes } from './routes/apps'
import { domainRoutes } from './routes/domains'
import { authRoutes } from './routes/auth'
import { mountCliExtras } from './routes/cli-extras'
import { dbRoutes } from './routes/db'
import { deploymentRoutes } from './routes/deployments'
import { envRoutes } from './routes/envs'
import { logRoutes } from './routes/logs'
import { planRoutes } from './routes/plan'
import { serveAppOrigin } from './proxy/app-origin'
import { openTicketRoutes } from './routes/open-ticket'
import { mountConsole } from './routes/console/index'
import { serviceRoutes } from './routes/services'
import { svRoutes } from './routes/sv'
import { uploadRoutes } from './routes/uploads'
import { escapeHtml } from './http/html'
import { Scheduler } from './scheduler'
import { fail } from './errors'
import { deleteApp, purgeApp, restoreApp } from './lifecycle'
import { HttpSupervisorClient } from './supervisor'
import { envStatus } from './views'

/** Assembles the engine from platform-owned dependencies without opening connections or listeners. */
export function buildCtx(config: Config, deps: Deps, timing: Timing = DEFAULT_TIMING): Ctx {
  const ctx = { config, bus: new EventBus(), timing, ...deps } as Ctx
  ctx.accessLog = new AccessLog(ctx)
  ctx.resources = new Resources(ctx)
  ctx.orchestrator = new Orchestrator(ctx)
  ctx.scheduler = new Scheduler(ctx)
  return ctx
}
const newRequestId = () => 'req_' + randomBytes(8).toString('hex')
function activityAction(method: string, rest: string): string | null {
  if (method !== 'GET') return method + ' ' + (rest || '/')
  return rest === '' || rest === '/' ? 'read status' : rest === '/context' ? 'read context' : null
}
export function createServer(ctx: Ctx): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toBody(), err.status as 400)
    const platform = err as Error & { getStatus?: () => number; getResponse?: () => unknown }
    if (typeof platform.getStatus === 'function') {
      const status = platform.getStatus()
      const response = platform.getResponse?.()
      const value = typeof response === 'object' && response ? (response as Record<string, unknown>) : {}
      const message = Array.isArray(value.message)
        ? value.message.join('; ')
        : String(value.message ?? platform.message)
      return c.json(
        {
          error: {
            code: String(
              value.code ?? (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request'),
            ),
            message,
            next: typeof value.next === 'string' ? value.next : 'check the request and organization permissions',
          },
        },
        status as 400,
      )
    }
    // Anything else is the platform's fault, never the caller's. The details (upstream URLs and
    // bodies, database text, stacks) stay in cp.log under an id; the caller gets a fixed message and
    // the id to report. An upstream 403 is the platform's key, not the caller's scope: unavailable.
    const id = newRequestId()
    const where = `${c.req.method} ${new URL(c.req.url).pathname}`
    if (err instanceof UpstreamError) {
      console.error(
        `[upstream] ${id} ${where}: ${err.message} (HTTP ${err.status})${err.body ? ` ${err.body.slice(0, 2000)}` : ''}`,
      )
      return c.json(
        {
          error: {
            code: 'unavailable',
            message: `a platform service (${err.service}) did not complete the request`,
            next: `retry in a minute; if it keeps failing, report error id ${id} to the platform operator`,
            request_id: id,
          },
        },
        503,
        { 'x-request-id': id },
      )
    }
    console.error(`[cp] internal ${id} ${where}:`, err)
    return c.json(
      {
        error: {
          code: 'internal',
          message: 'the control plane hit an internal error',
          next: `retry once; if it fails again, report error id ${id} to the platform operator`,
          request_id: id,
        },
      },
      500,
      { 'x-request-id': id },
    )
  })

  app.use('*', async (c, next) => {
    const principal =
      (c.env as { platformPrincipal?: PlatformPrincipal } | undefined)?.platformPrincipal ?? principalStorage.getStore()
    if (principal) return principalStorage.run(principal, next)
    return next()
  })
  app.use('/v1/*', apiRateLimit(ctx)) // F8: per-credential token bucket → 429 rate_limited
  mountConsole(app, ctx)
  // ---- admin -------------------------------------------------------------
  app.use('/v1/apps', async (c, next) => (c.req.method === 'POST' ? requireAdmin()(c, next) : next()))
  // Lifecycle actions inherit the organization and permission checks from the platform boundary.
  app.delete('/v1/apps/:app', requireAdmin(), async (c) => {
    const app = await ctx.store.appByNameAnyState(c.req.param('app'))
    if (!app) throw fail('not_found_app', `no app named "${c.req.param('app')}"`)
    if (c.req.query('purge') === '1') {
      await purgeApp(ctx, app)
      return c.json({ app: app.name, purged: true })
    }
    return c.json({ app: app.name, ...(await deleteApp(ctx, app, 'admin')) })
  })
  app.post('/v1/apps/:app/restore', requireAdmin(), async (c) => {
    const app = await ctx.store.appByNameAnyState(c.req.param('app'))
    if (!app) throw fail('not_found_app', `no app named "${c.req.param('app')}"`, 'it may already have been purged')
    await restoreApp(ctx, app, 'admin')
    return c.json({ app: app.name, restored: true })
  })
  app.use('/admin/*', requireAdmin())
  app.route('/admin', adminSecretRoutes(ctx))

  // ---- CLI API -----------------------------------------------------------
  const api = new Hono<{ Variables: Vars }>()
  api.use('*', requireApp(ctx.store))
  api.use('*', async (c, next) => {
    await next()
    if (c.res.status >= 400) return
    const appName = c.req.param('app')
    const rest = new URL(c.req.url).pathname.slice(`/v1/apps/${appName}`.length)
    const action = activityAction(c.req.method, rest)
    if (!action) return
    const env = /^\/envs\/([^/]+)/.exec(rest)?.[1] ?? null
    await ctx.store.recordActivity(c.get('app').id, env, c.get('actor'), action)
  })
  for (const sub of [
    appRoutes,
    envRoutes,
    planRoutes,
    uploadRoutes,
    deploymentRoutes,
    serviceRoutes,
    logRoutes,
    dbRoutes,
    authRoutes,
    openTicketRoutes,
    domainRoutes,
  ])
    api.route('/', sub(ctx))
  app.route('/v1/apps/:app', api)
  mountCliExtras(app, ctx)

  app.route('/sv', svRoutes(ctx))
  mountEndUserAuth(app, ctx)
  return app
}
