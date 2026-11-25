import { AsyncLocalStorage } from 'node:async_hooks'
import { fail } from './errors'

/** Supplied by the Nest boundary after platform authentication and permission checks. */
export interface PlatformPrincipal {
  organizationId: string
  userId: string
  actor: string
  permissions: string[]
  admin?: boolean
  email?: string
  name?: string
}

export const principalStorage = new AsyncLocalStorage<PlatformPrincipal>()

export function requireAppScope(scope: 'read:apps' | 'write:apps' | 'delete:apps'): void {
  if (!principalStorage.getStore()?.permissions.includes(scope))
    throw fail('forbidden', `App operation requires ${scope}`)
}
