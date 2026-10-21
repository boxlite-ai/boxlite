import type { VolumeSpec } from '@microcloud/shared';
import { newBoxToken, sha256hex } from './auth.js';
import type { AppRow, EnvRow } from './db.js';
import { now } from './db.js';
import type { Ctx } from './ctx.js';
import { UpstreamError, fail } from './errors.js';
import { sleep } from './http.js';
import { hostOf, withSslmode } from './neon.js';
import { BOX_AUTO_STOP_S, BOX_CMD, BOX_DISK_GB, BOX_SIZES, GATEWAY_PORT, IMAGE_REFS, SUPERVISOR_PROTOCOL } from './platform.js';
import type { Spec } from './spec.js';
import { supervisorOutdated, supervisorProtocol } from './supervisor.js';

export type Logger = (line: string) => void;

/** Platform resources of an env: its Neon branch, its Box, its URLs and runtime env. */
export class Resources {
  private readonly dbLocks = new Map<string, Promise<unknown>>();
  private readonly boxStatusCache = new Map<string, { status: string; at: number }>();
  private readonly wakes = new Map<string, { at: number; done: Promise<void> }>();

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {}

  // ---- URLs ----------------------------------------------------------------

  /** The pre-origins path prefix (`/<app>`, `/<app>--<env>`); the API origin now 301s it to the env origin. */
  static prefix(app: string, env: string): string {
    return env === 'main' ? `/${app}` : `/${app}--${env}`;
  }

  /**
   * The env's own origin, e.g. `https://10001-d-<hex>.proxy.dev.boxlite.ai` (no trailing slash):
   * BOXLITE_APP_URL, the URL in CLI/console/context responses and spec `assigned.app_url`.
   * The app lives at `/` of it (origins.ts).
   */
  appUrl(app: string, env: string): string {
    const a = this.ctx.store.appByNameAnyState(app);
    const e = a ? this.ctx.store.envByName(a.id, env) : undefined;
    return e ? this.ctx.origins.envUrl(e) : this.ctx.config.publicUrl + Resources.prefix(app, env);
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
      const value = this.ctx.store.secret(ref);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  // ---- Neon ----------------------------------------------------------------

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.dbLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.dbLocks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * One Neon project per app (`mc-<app>`, created on first use); `main` uses the project's default
   * branch, every other env its own branch off its `from` env.
   */
  async ensureDatabase(appId: string, envId: string, log: Logger = () => undefined): Promise<{ url: string; host: string; branchId: string }> {
    return this.locked(appId, async () => {
      const { store, neon } = this.ctx;
      let app = store.appById(appId)!;
      if (!app.neon_project_id) {
        log(`creating Neon project mc-${app.name}`);
        const p = await neon.createProject(`mc-${app.name}`);
        store.updateApp(app.id, { neon_project_id: p.projectId, neon_main_branch_id: p.mainBranchId, neon_host: p.host });
        const main = store.envByName(app.id, 'main');
        if (main) store.updateEnv(main.id, { neon_branch_id: p.mainBranchId, db_url: withSslmode(p.connectionUri) });
        app = store.appById(appId)!;
      }
      let env = store.envById(envId)!;
      if (!env.neon_branch_id) {
        let branchId: string;
        if (env.name === 'main') {
          branchId = app.neon_main_branch_id!;
        } else {
          const parent = store.envByName(app.id, env.from_env ?? 'main');
          const parentBranch = parent?.neon_branch_id ?? app.neon_main_branch_id;
          const init = env.with_data ? 'parent-data' : 'schema-only';
          log(`creating Neon branch ${env.name} from ${parent?.name ?? 'main'} (${init})`);
          branchId = (await neon.createBranch(app.neon_project_id!, env.name, parentBranch, init)).branchId;
        }
        store.updateEnv(env.id, { neon_branch_id: branchId });
        env = store.envById(envId)!;
      }
      if (!env.db_url) {
        const uri = await neon.connectionUri(app.neon_project_id!, env.neon_branch_id!);
        store.updateEnv(env.id, { db_url: withSslmode(uri) });
        env = store.envById(envId)!;
      }
      return { url: env.db_url!, host: hostOf(env.db_url!), branchId: env.neon_branch_id! };
    });
  }

  // ---- Box -----------------------------------------------------------------

  private volumeKey(volumes: VolumeSpec[]): string {
    return volumes
      .map((v) => `${v.name}:${v.mount}`)
      .sort()
      .join(',');
  }

  /**
   * Makes sure the env has a running Box with a registered tunnel and an answering supervisor.
   * A change of image, size or volume set cannot be applied to an existing Box, so the old Box is
   * stopped and a new one is created (its releases do not carry over; rollback stays per Box).
   */
  async ensureBox(app: AppRow, envId: string, want: { image: string; size: string; volumes: VolumeSpec[] }, deployment: number, log: Logger): Promise<EnvRow> {
    const { store, boxlite } = this.ctx;
    let env = store.envById(envId)!;
    const volumes = this.volumeKey(want.volumes);
    let box = env.box_id ? await boxlite.getBox(env.box_id) : null;
    let replacing = false;
    if (env.box_id && !box) {
      log(`Box ${env.box_id} no longer exists; creating a new one`);
      replacing = true;
    } else if (box && (env.box_image !== want.image || env.box_size !== want.size || (env.box_volumes ?? '') !== volumes)) {
      log(`runtime changed (image ${env.box_image}→${want.image}, size ${env.box_size}→${want.size}, volumes [${env.box_volumes ?? ''}]→[${volumes}]); replacing Box ${box.id}`);
      if (env.box_volumes || volumes) {
        // A managed volume can only be mounted by one Box, so the old Box has to go entirely.
        await boxlite.deleteBox(box.id);
      } else {
        await boxlite.stopBox(box.id).catch((err) => log(`stopping old Box failed (ignored): ${(err as Error).message}`));
      }
      box = null;
      replacing = true;
    }

    if (!box) {
      const size = BOX_SIZES[want.size]!;
      const token = newBoxToken();
      store.tx(() => {
        store.run('UPDATE box_tokens SET revoked_at = ? WHERE env_id = ? AND revoked_at IS NULL', now(), env.id);
        store.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), env.id, now());
      });
      const mounts: { managed_volume: string; guest_path: string }[] = [];
      if (want.volumes.length) {
        const existing = await boxlite.listVolumes();
        const recorded = new Map(store.envVolumes(env.id).map((r) => [r.name, r.volume_id]));
        // Pre-F10 envs: the CP's own record of what it mounted (`name:mount,…`).
        const legacy = new Set((env.box_volumes ?? '').split(',').filter(Boolean).map((e) => e.slice(0, e.indexOf(':'))));
        for (const v of want.volumes) {
          const name = `mc-${app.name}-${env.name}-${v.name}`;
          const id = recorded.get(name);
          const byId = id ? existing.find((x) => x.id === id) : undefined;
          if (!byId) {
            const sameName = existing.find((x) => x.name === name);
            if (sameName && !id && legacy.has(v.name)) {
              // Created by this CP before volume ids were recorded; adopt it by its id.
              log(`recording volume ${name} (${sameName.id})`);
              store.recordVolume(env.id, name, sameName.id);
            } else if (sameName) {
              // Never mount (or later delete) a volume this CP did not create (F10).
              throw fail('conflict', `a BoxLite volume named ${name} already exists and was not created for this environment`, 'rename the [[volume]] in boxlite.toml, or remove that volume in BoxLite');
            } else {
              log(`creating volume ${name}`);
              const created = await boxlite.createVolume(name);
              store.recordVolume(env.id, name, created.id);
            }
          }
          // BoxLite mounts managed volumes by name.
          mounts.push({ managed_volume: name, guest_path: v.mount });
        }
      }
      // A replaced Box may still exist (stopped), so the new one needs a distinct name.
      const name = replacing ? `app-${app.name}-${env.name}-${deployment}` : `app-${app.name}-${env.name}`;
      log(`creating Box ${name} (${want.image}, ${size.cpus} CPU / ${size.memory_mib} MiB)`);
      box = await boxlite.createBox({
        name,
        image: IMAGE_REFS[want.image]!,
        cpus: size.cpus,
        memory_mib: size.memory_mib,
        disk_size_gb: BOX_DISK_GB,
        // Identity headers are honoured only on requests carrying the forwarding secret, which only
        // the CP holds (app code runs as another uid and cannot read it; contracts §2.1, F2/F3).
        env: { BOXLITE_CP_URL: this.ctx.config.publicUrl, BOXLITE_BOX_TOKEN: token, BOXLITE_ENV_ID: env.id, SV_TRUST_USER_HEADERS: '1' },
        cmd: BOX_CMD,
        auto_stop: BOX_AUTO_STOP_S,
        auto_resume: true,
        network: { inbound: { mode: 'enabled' } },
        ...(mounts.length ? { volumes: mounts } : {}),
      });
      store.updateEnv(env.id, { box_id: box.id, box_url: null, box_image: want.image, box_size: want.size, box_volumes: volumes, services: null });
      env = store.envById(envId)!;
    } else if (box.status === 'stopped') {
      log(`starting Box ${box.id}`);
      await boxlite.startBox(box.id);
      this.noteWake(box.id);
    }

    if (!env.box_url) {
      const uri = await this.retry(() => boxlite.tunnel(env.box_id!, GATEWAY_PORT), 5, 3_000);
      log(`tunnel ${uri}`);
      store.updateEnv(env.id, { box_url: uri });
      env = store.envById(envId)!;
    }
    await this.waitForSupervisor(env, log);
    return store.envById(envId)!;
  }

  private async retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts || !(err instanceof UpstreamError)) throw err;
        await sleep(delayMs);
      }
    }
  }

  /**
   * Waits until the env's supervisor answers health with the control secret. A Box still running a
   * protocol-1 supervisor (one shared secret, runs as boxlite; contracts §2.1) refuses the control
   * secret with 403 but answers the forwarding secret: it is restarted once, its cmd then fetches
   * the current binary, which elevates itself and locks sudo down.
   */
  async waitForSupervisor(env: EnvRow, log: Logger): Promise<void> {
    const { supervisor, timing } = this.ctx;
    let deadline = Date.now() + timing.supervisorReadyMs;
    let lastErr = '';
    let restarted = false;
    let lastLegacyProbe = 0;
    log('waiting for the supervisor to answer');
    while (Date.now() < deadline) {
      let outdated: number | null = null;
      try {
        // Any 200 counts: `ok` only turns true once a release is live, which a fresh Box has not.
        // 403 (no secrets until the supervisor's first /sv/v1/spec) and connection errors land in
        // the catch and mean "not ready yet".
        const h = await supervisor.health(env.box_url!, env.control_secret);
        if (!supervisorOutdated(h, true)) return;
        outdated = supervisorProtocol(h, true);
      } catch (err) {
        lastErr = (err as Error).message;
        if (err instanceof UpstreamError && err.status === 403 && Date.now() - lastLegacyProbe >= Math.min(5_000, timing.pollMs * 10)) {
          lastLegacyProbe = Date.now();
          const legacy = await supervisor.legacyHealth(env.box_url!, env.gateway_secret).catch(() => null);
          if (legacy && supervisorOutdated(legacy)) outdated = supervisorProtocol(legacy);
        }
      }
      if (outdated !== null) {
        if (restarted) {
          throw fail('deploy_failed', `Box ${env.box_id} still runs supervisor protocol ${outdated} after a restart (this control plane needs ${SUPERVISOR_PROTOCOL})`, 'check that SV_BIN_DIR on the control plane holds the current supervisor build, then deploy again');
        }
        log(`Box ${env.box_id} runs supervisor protocol ${outdated}, older than ${SUPERVISOR_PROTOCOL}; restarting it to fetch the current supervisor`);
        await this.restartBox(env.box_id!);
        restarted = true;
        deadline = Date.now() + timing.supervisorReadyMs;
      }
      await sleep(timing.pollMs);
    }
    throw fail('deploy_failed', `the supervisor in Box ${env.box_id} did not answer within ${Math.round(timing.supervisorReadyMs / 1000)} s (${lastErr})`, 'check `boxlite-app logs --source system`, then deploy again');
  }

  /** Stop + start: the Box cmd re-runs, which is how a Box picks up a new supervisor. */
  async restartBox(boxId: string): Promise<void> {
    const { boxlite } = this.ctx;
    await boxlite.stopBox(boxId).catch((err) => console.error(`[resources] stop ${boxId}: ${(err as Error).message}`));
    await this.retry(() => boxlite.startBox(boxId), 5, 3_000);
    this.noteWake(boxId);
  }

  /**
   * Rollout of the F2/F3 supervisor (contracts §2.1): restarts every running Box whose supervisor
   * still speaks protocol 1. Stopped Boxes upgrade by themselves on their next wake (their cmd
   * fetches the current binary). Run once at CP start; failures are logged and left for the next
   * deploy, which runs the same check in waitForSupervisor.
   */
  async upgradeOutdatedSupervisors(log: Logger): Promise<string[]> {
    const { store, supervisor } = this.ctx;
    const restarted: string[] = [];
    const envs = store.all<EnvRow>('SELECT * FROM envs WHERE box_id IS NOT NULL AND box_url IS NOT NULL');
    for (const env of envs) {
      try {
        if ((await this.boxStatus(env.box_id!)) !== 'running') continue;
        const current = await supervisor.health(env.box_url!, env.control_secret).then(
          (h) => !supervisorOutdated(h, true),
          () => false,
        );
        if (current) continue;
        const legacy = await supervisor.legacyHealth(env.box_url!, env.gateway_secret).catch(() => null);
        if (!legacy || !supervisorOutdated(legacy)) continue;
        log(`env ${env.id}: Box ${env.box_id} runs supervisor protocol ${supervisorProtocol(legacy)}; restarting it`);
        await this.restartBox(env.box_id!);
        restarted.push(env.id);
      } catch (err) {
        log(`env ${env.id}: upgrade check failed: ${(err as Error).message}`);
      }
    }
    return restarted;
  }

  /** For apply/rollback: the existing Box must be up (no recreation), started if it auto-stopped. */
  async ensureRunning(envId: string, log: Logger): Promise<EnvRow> {
    const { store, boxlite } = this.ctx;
    const env = store.envById(envId)!;
    if (!env.box_id || !env.box_url) throw fail('deploy_failed', 'this environment has no Box yet', 'run `boxlite-app deploy` first');
    const box = await boxlite.getBox(env.box_id);
    if (!box) throw fail('deploy_failed', `Box ${env.box_id} no longer exists`, 'run `boxlite-app deploy` to create a new one');
    if (box.status === 'stopped') {
      log(`starting Box ${box.id}`);
      await boxlite.startBox(box.id);
      this.noteWake(box.id);
    }
    await this.waitForSupervisor(env, log);
    return env;
  }

  /**
   * Deletes the BoxLite volumes recorded for the env, by id (F10). A volume is recorded when this CP
   * creates it; nothing is ever matched by name, so another resource in the org is never touched.
   * Volumes of an env created before ids were recorded, and not deployed since, are left in place
   * and reported.
   */
  async deleteVolumes(app: AppRow, env: EnvRow): Promise<string[]> {
    const { store, boxlite } = this.ctx;
    for (const v of store.envVolumes(env.id)) {
      try {
        await boxlite.deleteVolume(v.volume_id);
      } catch (err) {
        if (!(err instanceof UpstreamError && err.status === 404)) throw err;
      }
      store.forgetVolume(env.id, v.name);
    }
    const unrecorded = (env.box_volumes ?? '')
      .split(',')
      .filter(Boolean)
      .map((e) => `mc-${app.name}-${env.name}-${e.slice(0, e.indexOf(':'))}`)
      .filter((name) => !store.envVolumes(env.id).some((r) => r.name === name));
    if (unrecorded.length) console.warn(`[resources] env ${env.id}: volumes without a recorded id were left in place: ${unrecorded.join(', ')}`);
    return unrecorded;
  }

  // ---- Box status / wake (app proxy) --------------------------------------

  async boxStatus(boxId: string): Promise<string> {
    const hit = this.boxStatusCache.get(boxId);
    if (hit && Date.now() - hit.at < 5_000) return hit.status;
    const box = await this.ctx.boxlite.getBox(boxId);
    const status = box?.status ?? 'missing';
    this.boxStatusCache.set(boxId, { status, at: Date.now() });
    return status;
  }

  /**
   * Stops a Box and remembers it as stopped. Observation (health probes, the console's polling)
   * only talks to running Boxes, and a request to a stopped Box wakes it, so without this the
   * very next page refresh would wake the Box it just put to sleep.
   */
  async sleep(boxId: string): Promise<void> {
    await this.ctx.boxlite.stopBox(boxId);
    this.boxStatusCache.set(boxId, { status: 'stopped', at: Date.now() });
  }

  private noteWake(boxId: string): void {
    this.boxStatusCache.delete(boxId);
    this.wakes.set(boxId, { at: Date.now(), done: Promise.resolve() });
  }

  /** True while a Box we woke is probably still booting its supervisor. */
  recentlyWoken(boxId: string): boolean {
    const w = this.wakes.get(boxId);
    return !!w && Date.now() - w.at < 180_000;
  }

  /** Starts a stopped Box once, however many requests ask at the same time. */
  async wake(boxId: string): Promise<void> {
    const w = this.wakes.get(boxId);
    if (w && Date.now() - w.at < 30_000) return w.done;
    const done = this.ctx.boxlite
      .startBox(boxId)
      .catch((err) => console.error(`[wake] start ${boxId} failed: ${(err as Error).message}`))
      .then(() => {
        this.boxStatusCache.delete(boxId);
      });
    this.wakes.set(boxId, { at: Date.now(), done });
    return done;
  }
}
