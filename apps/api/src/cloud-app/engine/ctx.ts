import type { AppDatabase } from './appdb'
import type { BoxliteClient } from './boxlite'
import type { AccessLog } from './console-access'
import type { Config } from './config'
import type { Store } from './db'
import type { EventBus } from './events'
import type { NeonClient } from './neon'
import type { Orchestrator } from './orchestrator'
import type { Origins } from './origins'
import type { Resources } from './resources'
import type { Scheduler } from './scheduler'
import type { SupervisorClient } from './supervisor'

/** External systems, injected so tests can swap in fakes. */
export interface CredentialView {
  id: string
  last4: string
  created_at: string
  last_used_at: string | null
}
export interface AppCredentials {
  issue(app: import('./db').AppRow, actor: string): Promise<string>
  list(app: import('./db').AppRow): Promise<CredentialView[]>
  revoke(app: import('./db').AppRow, id: string, actor: string): Promise<void>
  rotate(app: import('./db').AppRow, actor: string): Promise<string>
  authenticate(token: string): Promise<{ appId: string; organizationId: string; actor: string } | null>
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
