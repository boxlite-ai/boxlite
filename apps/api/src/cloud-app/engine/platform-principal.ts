import { AsyncLocalStorage } from 'node:async_hooks'

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
