import type { AppDatabase } from './appdb.js';
import type { BlobStore } from './blobs.js';
import type { BoxliteClient } from './boxlite.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { EventBus } from './events.js';
import type { NeonClient } from './neon.js';
import type { Orchestrator } from './orchestrator.js';
import type { Origins, TunnelRegistrar } from './origins.js';
import type { Resources } from './resources.js';
import type { Scheduler } from './scheduler.js';
import type { SupervisorClient } from './supervisor.js';

/** External systems, injected so tests can swap in fakes. */
export interface Deps {
  boxlite: BoxliteClient;
  neon: NeonClient;
  supervisor: SupervisorClient;
  appdb: AppDatabase;
  /** HTTP to OAuth providers (token exchange, profile); tests inject a fake GitHub. Defaults to fetch. */
  oauthFetch?: typeof fetch;
  /** Registers the public tunnel to a CP Box port (origins.ts); tests inject a fake. Defaults to the BoxLite API. */
  registerTunnel?: TunnelRegistrar;
}

export interface Timing {
  /** Box create/start → supervisor answers /.boxlite/sv/health. */
  supervisorReadyMs: number;
  /** POST /deploy → `built`. */
  buildMs: number;
  /** POST /activate or /rollback → `live`. */
  activateMs: number;
  pollMs: number;
}

export const DEFAULT_TIMING: Timing = {
  supervisorReadyMs: 120_000,
  buildMs: 20 * 60_000,
  activateMs: 3 * 60_000,
  pollMs: 2_000,
};

export interface Ctx extends Deps {
  config: Config;
  store: Store;
  bus: EventBus;
  blobs: BlobStore;
  resources: Resources;
  orchestrator: Orchestrator;
  origins: Origins;
  scheduler: Scheduler;
  timing: Timing;
}
