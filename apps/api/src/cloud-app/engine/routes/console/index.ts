import { Hono } from 'hono'
import type { Ctx } from '../../ctx'
import { consoleViewer, requireConsoleApi } from '../../console-auth'
import { RESERVED_NAMES } from '../../platform'
import { fail } from '../../errors'
import { consoleKit } from './kit'
import { consoleAppRoutes } from './apps'
import { consoleDeploymentRoutes } from './deployments'
import { consoleVolumeRoutes } from './volumes'
import { consoleDomainRoutes } from './domains'
import { consoleVariableRoutes } from './variables'
import { consoleAuthRoutes } from './auth'
import { consoleLogRoutes } from './logs'
import { consoleDatabaseRoutes } from './database'

/** Projection handlers share the authenticated management namespace. */
export function mountConsole(root: Hono, ctx: Ctx): void {
  root.route('/v1', consoleApi(root, ctx))
}
function consoleApi(root: Hono, ctx: Ctx) {
  const api = new Hono()
  const k = consoleKit(root, ctx)
  api.use('*', requireConsoleApi(ctx))

  /** The authenticated platform member and selected organization. */
  api.get('/session', async (c) => {
    const v = consoleViewer(ctx, c)!
    const base = { controlPlane: ctx.config.managementUrl, reservedNames: [...RESERVED_NAMES].sort() }
    const apps = (await ctx.store.get<{ n: number }>('SELECT count(*) AS n FROM apps WHERE org_id = ?', v.org.id))!.n
    return c.json({
      ...base,
      user: v.user.name ?? v.user.login ?? v.user.email ?? 'you',
      admin: false,
      profile: { name: v.user.name, login: v.user.login, email: v.user.email, avatarUrl: null },
      organization: {
        id: v.org.id,
        name: v.org.name,
        role: v.role,
        suspendedReason: v.org.suspended_reason,
        appLimit: v.org.app_limit,
        apps,
      },
    })
  })

  consoleAppRoutes(api, k)
  consoleDeploymentRoutes(api, k)
  consoleVolumeRoutes(api, k)
  consoleDomainRoutes(api, k)
  consoleVariableRoutes(api, k)
  consoleAuthRoutes(api, k)
  consoleLogRoutes(api, k)
  consoleDatabaseRoutes(api, k)

  return api
}
