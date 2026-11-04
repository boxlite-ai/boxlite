import type { EnvRow } from './db'

/** URLs are assigned by platform Domain services; the engine opens no listeners or tunnels. */
export interface Origins {
  readonly apiUrl: string
  consoleUrl(): string
  envUrl(env: EnvRow): Promise<string> | string
}
