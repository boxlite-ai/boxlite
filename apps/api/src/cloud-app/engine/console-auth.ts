import type { Context, MiddlewareHandler } from 'hono'
import type { Ctx } from './ctx'
import { principalStorage } from './platform-principal'
import type { Viewer } from './orgs'
import { fail } from './errors'

/** Console projections inherit the platform identity; they establish no session of their own. */
export function consoleViewer(_ctx: Pick<Ctx, 'store' | 'config'>, c: Context): Viewer | null {
  const principal =
    (c.env as { platformPrincipal?: import('./platform-principal').PlatformPrincipal } | undefined)
      ?.platformPrincipal ?? principalStorage.getStore()
  if (!principal) return null
  return {
    kind: 'user',
    user: {
      id: principal.userId,
      email: principal.email ?? null,
      name: principal.name ?? null,
      login: principal.name ?? null,
    },
    org: { id: principal.organizationId, name: '', app_limit: null, suspended_reason: null },
    role: 'owner',
  }
}
export function requireConsoleApi(ctx: Pick<Ctx, 'store' | 'config'>): MiddlewareHandler {
  return async (c, next) => {
    if (!consoleViewer(ctx, c)) throw fail('unauthenticated', 'platform authentication required')
    await next()
  }
}
