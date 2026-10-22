/** An env's platform resources behind one object (`ctx.resources`): URLs, current spec and runtime env here; Box, database, volumes and wake in resources/. */
import { orgSecret } from './orgs.js';
import type { VolumeSpec } from '@microcloud/shared';
import { now, type AppRow, type EnvRow } from './db.js';
import type { Ctx } from './ctx.js';
import type { Spec } from './spec.js';
import type { ServiceState } from './supervisor.js';
import { BoxProvisioner, type Logger } from './resources/boxes.js';
import { DatabaseProvisioner } from './resources/database.js';
import { deleteVolumes } from './resources/volumes.js';
import { BoxWaker } from './resources/wake.js';

/** Platform resources of an env: its Neon branch, its Box, its URLs and runtime env. */
export class Resources {
  private readonly waker: BoxWaker;
  private readonly boxes: BoxProvisioner;
  private readonly databases: DatabaseProvisioner;

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {
    this.waker = new BoxWaker(ctx);
    this.boxes = new BoxProvisioner(ctx, this.waker);
    this.databases = new DatabaseProvisioner(ctx);
  }

  // ---- URLs ----------------------------------------------------------------

  /**
   * The env's own origin, e.g. `https://10001-d-<hex>.proxy.dev.boxlite.ai` (no trailing slash):
   * BOXLITE_APP_URL, the URL in CLI/console/context responses and spec `assigned.app_url`.
   * The app lives at `/` of it (origins.ts).
   */
  appUrl(app: string, env: string): string {
    const a = this.ctx.store.appByNameAnyState(app);
    const e = a ? this.ctx.store.envByName(a.id, env) : undefined;
    // An env that no longer exists has no origin; the API origin is the only honest answer.
    return e ? this.ctx.origins.envUrl(e) : this.ctx.config.publicUrl;
  }

  // ---- env lookups ---------------------------------------------------------

  /** The spec the env is currently serving (live deployment), falling back to the latest version. */
  currentSpec(env: EnvRow): Spec | undefined {
    const { store } = this.ctx;
    if (env.live_deployment) {
      const d = store.deployment(env.id, env.live_deployment);
      if (d?.spec_version) return store.spec(env.id, d.spec_version);
    }
    return store.spec(env.id);
  }

  effectiveAccess(env: EnvRow): 'private' | 'org' | 'public' {
    return (env.access_override ?? this.currentSpec(env)?.access ?? 'private') as 'private' | 'org' | 'public';
  }

  /**
   * The process env the supervisor gives every service (contracts §2.2): platform vars, the
   * env's DATABASE_URL, [variables], and [secrets] resolved from the CP's org secret table.
   */
  runtimeEnv(app: AppRow, env: EnvRow, spec: Spec | undefined): Record<string, string> {
    const out: Record<string, string> = {
      BOXLITE_APP_URL: this.appUrl(app.name, env.name),
      BOXLITE_ENV: env.name,
      BOXLITE_APP: app.name,
    };
    if (spec?.database && env.db_url) out.DATABASE_URL = env.db_url;
    Object.assign(out, spec?.variables ?? {});
    for (const [name, ref] of Object.entries(spec?.secrets ?? {})) {
      const value = orgSecret(this.ctx, app, ref);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  // ---- database (resources/database.ts) -------------------------------------

  ensureDatabase(appId: string, envId: string, log?: Logger): Promise<{ url: string; host: string; branchId: string }> {
    return this.databases.ensureDatabase(appId, envId, log);
  }

  // ---- Box (resources/boxes.ts) and volumes (resources/volumes.ts) ----------

  ensureBox(app: AppRow, envId: string, want: { image: string; size: string; volumes: VolumeSpec[] }, deployment: number, log: Logger): Promise<EnvRow> {
    return this.boxes.ensureBox(app, envId, want, deployment, log);
  }

  waitForSupervisor(env: EnvRow, log: Logger): Promise<void> {
    return this.boxes.waitForSupervisor(env, log);
  }

  ensureRunning(envId: string, log: Logger): Promise<EnvRow> {
    return this.boxes.ensureRunning(envId, log);
  }

  deleteVolumes(app: AppRow, env: EnvRow): Promise<string[]> {
    return deleteVolumes(this.ctx, app, env);
  }

  // ---- Box status / wake for the app proxy (resources/wake.ts) --------------

  boxStatus(boxId: string): Promise<string> {
    return this.waker.boxStatus(boxId);
  }

  sleep(boxId: string): Promise<void> {
    return this.waker.sleep(boxId);
  }

  recentlyWoken(boxId: string): boolean {
    return this.waker.recentlyWoken(boxId);
  }

  wake(boxId: string): Promise<void> {
    return this.waker.wake(boxId);
  }

  wakeFailure(boxId: string): string | null {
    return this.waker.wakeFailure(boxId);
  }

  /**
   * The env's Box state and its services as they are now: asked from the supervisor when the Box
   * is up (within `timeoutMs`; never wakes it), else the last report. A fresh answer is stored as
   * the new last report. The console, `GET …/services` and the agent context all read this.
   */
  async liveServices(env: EnvRow, timeoutMs = 3_000): Promise<{ box: string | null; services: ServiceState[]; fresh: boolean }> {
    const box = env.box_id ? await this.boxStatus(env.box_id).catch(() => 'unknown') : null;
    if (box === 'running' && env.box_url) {
      let timer: NodeJS.Timeout | undefined;
      const h = await Promise.race([
        this.ctx.supervisor.health(env.box_url, env.control_secret).catch(() => null),
        new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs))),
      ]);
      clearTimeout(timer);
      if (h) {
        this.ctx.store.updateEnv(env.id, { services: JSON.stringify(h.services), services_at: now() });
        return { box, services: h.services, fresh: true };
      }
    }
    return { box, services: storedServices(env), fresh: false };
  }
}

/** The supervisor's last service report, as stored on the env. */
export function storedServices(env: EnvRow): ServiceState[] {
  try {
    return env.services ? (JSON.parse(env.services) as ServiceState[]) : [];
  } catch {
    return [];
  }
}
