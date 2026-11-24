/** An env's platform resources behind one object (`ctx.resources`): URLs, current spec and runtime env here; Box, database, volumes and wake in resources/. */
import { secretValue } from './orgs'
import type { BoxUsage, VolumeSpec } from '@boxlite-ai/cloud-app-shared'
import { now, type AppRow, type EnvRow } from './db'
import type { Ctx } from './ctx'
import type { Spec } from './spec'
import type { ServiceState } from './supervisor'
import { BoxProvisioner, type Logger } from './resources/boxes'
import { DatabaseProvisioner } from './resources/database'
import { deleteVolumes } from './resources/volumes'
import { BoxWaker } from './resources/wake'

/** Platform resources of an env: its Neon branch, its Box, its URLs and runtime env. */
export class Resources {
  private readonly waker: BoxWaker
  private readonly boxes: BoxProvisioner
  private readonly databases: DatabaseProvisioner

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {
    this.waker = new BoxWaker(ctx)
    this.boxes = new BoxProvisioner(ctx, this.waker)
    this.databases = new DatabaseProvisioner(ctx)
  }

  // ---- URLs ----------------------------------------------------------------

  /**
   * The env's own origin, e.g. `https://10001-d-<hex>.proxy.dev.boxlite.ai` (no trailing slash):
   * BOXLITE_APP_URL, the URL in CLI/console/context responses and spec `assigned.app_url`.
   * The app lives at `/` of it (origins.ts).
   */
  async appUrl(app: string, env: string): Promise<string> {
    const a = await this.ctx.store.appByNameAnyState(app)
    const e = a ? await this.ctx.store.envByName(a.id, env) : undefined
    // An env that no longer exists has no origin; the API origin is the only honest answer.
    return e ? await this.ctx.origins.envUrl(e) : this.ctx.config.publicUrl
  }

  // ---- env lookups ---------------------------------------------------------

  /** The spec the env is currently serving (live deployment), falling back to the latest version. */
  async currentSpec(env: EnvRow): Promise<Spec | undefined> {
    const { store } = this.ctx
    if (env.live_deployment) {
      const d = await store.deployment(env.id, env.live_deployment)
      if (d?.spec_version) return await store.spec(env.id, d.spec_version)
    }
    return await store.spec(env.id)
  }

  async effectiveAccess(env: EnvRow): Promise<'private' | 'org' | 'public'> {
    return (env.access_override ?? (await this.currentSpec(env))?.access ?? 'private') as 'private' | 'org' | 'public'
  }

  /**
   * The process env the supervisor gives every service (contracts §2.2): platform vars, the
   * env's DATABASE_URL, [variables], and [secrets] resolved from the CP's org secret table.
   */
  async runtimeEnv(app: AppRow, env: EnvRow, spec: Spec | undefined): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      BOXLITE_APP_URL: await this.appUrl(app.name, env.name),
      BOXLITE_ENV: env.name,
      BOXLITE_APP: app.name,
    }
    if (spec?.database && env.db_url) out.DATABASE_URL = env.db_url
    Object.assign(out, spec?.variables ?? {})
    for (const [name, ref] of Object.entries(spec?.secrets ?? {})) {
      const value = await secretValue(this.ctx, app, ref)
      if (value !== undefined) out[name] = value
    }
    return out
  }

  // ---- database (resources/database.ts) -------------------------------------

  async ensureDatabase(
    appId: string,
    envId: string,
    log?: Logger,
    signal?: AbortSignal,
  ): Promise<{ url: string; host: string; branchId: string }> {
    return await this.databases.ensureDatabase(appId, envId, log, signal)
  }

  // ---- Box (resources/boxes.ts) and volumes (resources/volumes.ts) ----------

  async ensureBox(
    app: AppRow,
    envId: string,
    want: { image: string; size: string; volumes: VolumeSpec[] },
    deployment: number,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<EnvRow> {
    return await this.boxes.ensureBox(app, envId, want, deployment, log, signal)
  }

  async waitForSupervisor(env: EnvRow, log: Logger): Promise<void> {
    return await this.boxes.waitForSupervisor(env, log)
  }

  async ensureRunning(envId: string, log: Logger, signal?: AbortSignal): Promise<EnvRow> {
    return await this.boxes.ensureRunning(envId, log, signal)
  }

  async deleteVolumes(app: AppRow, env: EnvRow): Promise<void> {
    return await deleteVolumes(this.ctx, app, env)
  }

  // ---- Box status / wake for the app proxy (resources/wake.ts) --------------

  async boxStatus(boxId: string): Promise<string> {
    return await this.waker.boxStatus(boxId)
  }

  async sleep(boxId: string): Promise<void> {
    return await this.waker.sleep(boxId)
  }

  recentlyWoken(boxId: string): boolean {
    return this.waker.recentlyWoken(boxId)
  }

  async wake(boxId: string): Promise<void> {
    return await this.waker.wake(boxId)
  }

  wakeFailure(boxId: string): string | null {
    return this.waker.wakeFailure(boxId)
  }

  /**
   * The env's Box state and its services as they are now: asked from the supervisor when the Box
   * is up (within `timeoutMs`; never wakes it), else the last report. A fresh answer is stored as
   * the new last report. The console, `GET …/services` and the agent context all read this.
   */
  /** `usage` is read only from a running Box: null when it sleeps or does not answer. */
  async liveServices(
    env: EnvRow,
    timeoutMs = 3_000,
  ): Promise<{ box: string | null; services: ServiceState[]; fresh: boolean; usage: BoxUsage | null }> {
    const box = env.active_box_id ? await this.boxStatus(env.active_box_id).catch(() => 'unknown') : null
    if (box === 'running' && env.box_url) {
      let timer: NodeJS.Timeout | undefined
      const h = await Promise.race([
        this.ctx.supervisor.health(env.box_url, env.control_secret).catch(() => null),
        new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs))),
      ])
      clearTimeout(timer)
      if (h) {
        await this.ctx.store.updateEnv(env.id, { services: JSON.stringify(h.services), services_at: now() })
        return { box, services: h.services, fresh: true, usage: h.box ?? null }
      }
    }
    return { box, services: storedServices(env), fresh: false, usage: null }
  }
}

/** The supervisor's last service report, as stored on the env. */
export function storedServices(env: EnvRow): ServiceState[] {
  try {
    return env.services ? (JSON.parse(env.services) as ServiceState[]) : []
  } catch {
    return []
  }
}
