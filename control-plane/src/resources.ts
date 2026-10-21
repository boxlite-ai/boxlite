import type { VolumeSpec } from '@microcloud/shared';
import { newBoxToken, sha256hex } from './auth.js';
import type { AppRow, EnvRow } from './db.js';
import { now } from './db.js';
import type { Ctx } from './ctx.js';
import { UpstreamError, fail } from './errors.js';
import { retry, sleep } from './http.js';
import { recordLogs } from './logsink.js';
import { hostOf, withSslmode } from './neon.js';
import { BOX_AUTO_STOP_S, BOX_CMD, BOX_DISK_GB, BOX_SIZES, GATEWAY_PORT, IMAGE_REFS, SUPERVISOR_PROTOCOL } from './platform.js';
import type { Spec } from './spec.js';

export type Logger = (line: string) => void;

/** The BoxLite managed volume of an env's `[[volume]]` (contracts §4.1 "Volumes"). */
export const volumeName = (app: string, env: string, volume: string) => `mc-${app}-${env}-${volume}`;

/** A wake is not repeated within this window (concurrent requests share it). */
const WAKE_RETRY_MS = 30_000;

/** Platform resources of an env: its Neon branch, its Box, its URLs and runtime env. */
const SUPERVISOR_TIMEOUT = 'supervisor_timeout';
const isSupervisorTimeout = (err: unknown) => (err as { details?: { reason?: string } })?.details?.reason === SUPERVISOR_TIMEOUT;

export class Resources {
  private readonly dbLocks = new Map<string, Promise<unknown>>();
  private readonly boxStatusCache = new Map<string, { status: string; at: number }>();
  private readonly wakes = new Map<string, { at: number; done: Promise<void> }>();
  /** The last failed wake per Box, kept for the 30 s a wake is not retried. */
  private readonly wakeFailures = new Map<string, { at: number; message: string }>();

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {}

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
        store.updateApp(app.id, { neon_project_id: p.projectId, neon_main_branch_id: p.mainBranchId });
        const main = store.envByName(app.id, 'main');
        if (main) store.updateEnv(main.id, { neon_branch_id: p.mainBranchId, db_url: withSslmode(p.connectionUri) });
        app = store.appById(appId)!;
        // The read-only login reads use (F5), created through the Neon API; reads also do it lazily.
        if (main) {
          await this.ctx.appdb.ensureReader(withSslmode(p.connectionUri)).catch((err: Error) => log(`warning: read-only database login not ready yet: ${err.message}`));
        }
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
          // A SQL-created reader role would make Neon refuse schema-only branches (412); the CP's
          // start-up pass (DbReaders.migrateAll) removed those once, and nothing creates them now.
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
    try {
      return await this.ensureBoxOnce(app, envId, want, deployment, log, false);
    } catch (err) {
      const env = this.ctx.store.envById(envId)!;
      // Self-heal a Box that never came up. BoxLite occasionally hands out a Box without working
      // outbound network (measured 2026-10-22: no DNS, no route), so its boot cannot download the
      // supervisor and it never answers. A Box that never served a release holds nothing worth
      // keeping, so replace it once instead of letting the agent retry the same dead Box.
      if (!isSupervisorTimeout(err) || env.live_deployment || !env.box_id) throw err;
      log(`Box ${env.box_id} never started its supervisor (it usually means the Box has no outbound network); replacing it with a new Box`);
      await this.ctx.boxlite.deleteBox(env.box_id).catch((e) => log(`deleting Box ${env.box_id} failed (ignored): ${(e as Error).message}`));
      this.ctx.store.updateEnv(env.id, { box_id: null, box_url: null, services: null });
      return this.ensureBoxOnce(app, envId, want, deployment, log, true);
    }
  }

  private async ensureBoxOnce(app: AppRow, envId: string, want: { image: string; size: string; volumes: VolumeSpec[] }, deployment: number, log: Logger, retrying: boolean): Promise<EnvRow> {
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
          const name = volumeName(app.name, env.name, v.name);
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
      const name = retrying ? `app-${app.name}-${env.name}-${deployment}-r` : replacing ? `app-${app.name}-${env.name}-${deployment}` : `app-${app.name}-${env.name}`;
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
      const uri = await retry(() => boxlite.tunnel(env.box_id!, GATEWAY_PORT), { attempts: 5, delayMs: 3_000, retryable: (err) => err instanceof UpstreamError });
      log(`tunnel ${uri}`);
      store.updateEnv(env.id, { box_url: uri });
      env = store.envById(envId)!;
    }
    await this.waitForSupervisor(env, log);
    return store.envById(envId)!;
  }

  /**
   * Waits until the env's supervisor answers health with the control secret. 403 (no secrets until
   * the supervisor's first /sv/v1/spec) and connection errors mean "not ready yet".
   *
   * Every Box runs wire protocol 2 since the 2026-10-21 rollout, and a Box downloads the current
   * supervisor on every start, so the CP no longer restarts old ones. A supervisor that still
   * reports an older protocol means the CP serves an old build: that is refused, not worked around.
   */
  async waitForSupervisor(env: EnvRow, log: Logger): Promise<void> {
    const { supervisor, timing } = this.ctx;
    const deadline = Date.now() + timing.supervisorReadyMs;
    let lastErr = '';
    log('waiting for the supervisor to answer');
    while (Date.now() < deadline) {
      let version: number | undefined;
      try {
        // Any 200 counts: `ok` only turns true once a release is live, which a fresh Box has not.
        // An answer to the control secret without `version` is protocol 2 (protocol 1 refuses it).
        version = (await supervisor.health(env.box_url!, env.control_secret)).version ?? SUPERVISOR_PROTOCOL;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      if (version !== undefined) {
        if (version >= SUPERVISOR_PROTOCOL) return;
        throw fail('deploy_failed', `Box ${env.box_id} runs supervisor protocol ${version}; this control plane needs ${SUPERVISOR_PROTOCOL}`, 'check that SV_BIN_DIR on the control plane holds the current supervisor build, then deploy again');
      }
      await sleep(timing.pollMs);
    }
    throw fail('deploy_failed', `the supervisor in Box ${env.box_id} did not answer within ${Math.round(timing.supervisorReadyMs / 1000)} s (${lastErr})`, 'read the Box boot with `boxlite-app app logs --source system --since 30m`, then `boxlite-app deploy` again', { reason: SUPERVISOR_TIMEOUT });
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
      .map((e) => volumeName(app.name, env.name, e.slice(0, e.indexOf(':'))))
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

  /**
   * Starts a stopped Box once, however many requests ask at the same time. A failure (quota,
   * a refused key) is written to the env's `system` log and kept for 30 s, so visitors get an
   * error page instead of "Starting…" forever; after that the next request tries again.
   */
  async wake(boxId: string): Promise<void> {
    const w = this.wakes.get(boxId);
    if (w && Date.now() - w.at < WAKE_RETRY_MS) return w.done;
    this.wakeFailures.delete(boxId);
    const done = this.ctx.boxlite
      .startBox(boxId)
      .catch((err) => this.wakeFailed(boxId, err as Error))
      .then(() => {
        this.boxStatusCache.delete(boxId);
      });
    this.wakes.set(boxId, { at: Date.now(), done });
    return done;
  }

  /** Why the last wake of this Box failed, while it is not retried yet; null otherwise. */
  wakeFailure(boxId: string): string | null {
    const f = this.wakeFailures.get(boxId);
    return f && Date.now() - f.at < WAKE_RETRY_MS ? f.message : null;
  }

  private wakeFailed(boxId: string, err: Error): void {
    console.error(`[wake] start ${boxId} failed: ${err.message}`);
    this.wakeFailures.set(boxId, { at: Date.now(), message: err.message });
    const env = this.ctx.store.get<{ id: string }>('SELECT id FROM envs WHERE box_id = ?', boxId);
    if (env) {
      recordLogs(this.ctx, env.id, [{ ts: now(), source: 'system', level: 'error', line: `could not start Box ${boxId} for a request: ${err.message}; the next request after 30 s tries again`, deployment: null }]);
    }
  }
}
