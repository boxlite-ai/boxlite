import type { AppDatabase } from './appdb'
import type { BoxliteClient, VolumeInfo } from './boxlite'
import type { AccessLog } from './console-access'
import type { Config } from './config'
import type { AppRow, EnvRow, Store } from './db'
import type { EventBus } from './events'
import type { NeonClient } from './neon'
import type { Orchestrator } from './orchestrator'
import type { Origins } from './origins'
import type { Resources } from './resources'
import type { Scheduler } from './scheduler'
import type { SupervisorClient } from './supervisor'

export interface AppCredentials {
  /** A recognized platform key is never forwarded, even if it cannot access Apps. */
  authenticate(token: string): Promise<{ organizationId: string; canReadApps: boolean } | null>
}
export interface AppVolumes {
  list(app: AppRow, environment: EnvRow): Promise<VolumeInfo[]>
  create(app: AppRow, environment: EnvRow, name: string): Promise<VolumeInfo>
  remove(app: AppRow, environment: EnvRow, volumeId: string): Promise<void>
}
export interface AppSourceStore {
  has(appId: string, sha: string): Promise<boolean>
  put(
    appId: string,
    sha: string,
    body: import('node:stream').Readable,
    maxBytes: number,
  ): Promise<{ bytes: number; deduped: boolean }>
  read(appId: string, sha: string): import('node:stream').Readable
  deleteApp(appId: string): Promise<void>
}
export interface Deps {
  store: Store
  blobs: AppSourceStore
  credentials: AppCredentials
  origins: Origins
  domains: import('./services/domains').AppDomains
  volumes: AppVolumes
  tunnelHeaders?: (boxUrl: string) => Promise<Record<string, string>>
  organizationMember?: (organizationId: string, provider: string, providerUserId: string) => Promise<boolean>
  boxlite: BoxliteClient
  neon: NeonClient
  supervisor: SupervisorClient
  appdb: AppDatabase
  /** HTTP to OAuth providers (token exchange, profile); tests inject a fake GitHub. Defaults to fetch. */
  oauthFetch?: typeof fetch
}

export interface Timing {
  /** Box create/start → supervisor answers /.boxlite/sv/health. */
  supervisorReadyMs: number
  /** POST /deploy → `built`. */
  buildMs: number
  /** POST /activate or /rollback → `live`. */
  activateMs: number
  pollMs: number
}

export const DEFAULT_TIMING: Timing = {
  supervisorReadyMs: 120_000,
  buildMs: 20 * 60_000,
  activateMs: 3 * 60_000,
  pollMs: 2_000,
}

export interface Ctx extends Deps {
  config: Config
  store: Store
  bus: EventBus
  blobs: AppSourceStore
  /** The app proxy's request log (console Logs `access`, Overview metrics); one per CP. */
  accessLog: AccessLog
  resources: Resources
  orchestrator: Orchestrator
  origins: Origins
  scheduler: Scheduler
  timing: Timing
}
