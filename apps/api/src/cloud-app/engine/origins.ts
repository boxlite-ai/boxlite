import type { EnvRow } from './db'
import { fail } from './errors'

export function assignedAppUrl(env: EnvRow): string {
  if (!env.public_url) throw fail('conflict', 'This environment has no assigned URL')
  return env.public_url
}

/** URLs are assigned by platform Domain services; the engine opens no listeners or tunnels. */
export interface Origins {
  readonly apiUrl: string
  consoleUrl(): string
  envUrl(env: EnvRow): Promise<string> | string
}
