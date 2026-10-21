import { linkSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { checkLocal, type Manifest } from '@microcloud/shared';
import type { AppRow, Deployment, DeploymentError, DeploymentStatus, EnvRow, LogLine, MigrationFile, SnapshotFile, Step } from './db.js';
import { ACTIVE_STATUSES, now } from './db.js';
import { ensureUserMirror } from './enduser-auth.js';
import { BOX_SIZES } from './platform.js';
import type { Ctx } from './ctx.js';
import { HttpError, UpstreamError, fail } from './errors.js';
import { sleep } from './http.js';
import { depTopic, svTopic } from './events.js';
import { recordLogs } from './logsink.js';
import { MIGRATION_FILE_RE_CP } from './migrations.js';
import { buildSpec, classifyMigrations, type AppliedMigration, type Spec } from './spec.js';
import type { ServiceState } from './supervisor.js';
import { deploymentView, logTail } from './views.js';

/** What the supervisor reports on POST /sv/v1/status. */
export interface SupervisorStatus {
  deployment: number;
  phase: 'building' | 'built' | 'starting' | 'live' | 'failed';
  step?: string;
  error?: string;
  log_tail?: string[];
  services?: ServiceState[];
}

class Cancelled extends Error {}

/** A failure with the step it belongs to, for Deployment.error. */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly logTail?: string[],
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Runs deployments. One queue per env: a deployment starts only when the previous one in that env
 * finished, so `queued` really means "waiting for the env", and two deployments never race for the
 * same Box or database branch.
 */
export class Orchestrator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  /** env → the deployment being worked on and the release number the supervisor was told to run. */
  private readonly active = new Map<string, { number: number; release: number | null; activating: boolean }>();
  /** `${envId}:${release}` → last status the supervisor reported for that release. */
  private readonly svStatus = new Map<string, SupervisorStatus & { at: number }>();

  constructor(private readonly ctx: Ctx) {}

  // ---- queue -----------------------------------------------------------------

  enqueue(envId: string, number: number): void {
    const prev = this.queues.get(envId) ?? Promise.resolve();
    const next = prev.then(() => this.run(envId, number)).catch((err) => console.error(`[orchestrator] ${envId}#${number}`, err));
    this.queues.set(envId, next);
  }

  /** Resolves when every queued job of the env has finished (tests, shutdown). */
  async idle(envId: string): Promise<void> {
    for (;;) {
      const p = this.queues.get(envId);
      if (!p) return;
      await p;
      if (this.queues.get(envId) === p) return;
    }
  }

  /** On CP start: jobs that were mid-flight cannot be resumed safely; queued ones run again. */
  resume(): void {
    const { store } = this.ctx;
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    for (const d of store.deploymentsWhere(`status IN (${placeholders}) ORDER BY env_id, number`, ...ACTIVE_STATUSES)) {
      if (d.status === 'queued') {
        this.enqueue(d.env_id, d.number);
        continue;
      }
      const running = d.steps.find((s) => s.status === 'running');
      const steps = d.steps.map((s): Step => (s.status === 'running' ? { ...s, status: 'failed' } : s));
      store.updateDeployment(d.env_id, d.number, {
        status: 'failed',
        steps,
        finished_at: now(),
        error: { step: running?.name ?? 'control-plane', message: 'the control plane restarted while this deployment was running' },
      });
      const env = store.envById(d.env_id);
      if (env) store.updateEnv(env.id, { requested_deployment: env.live_deployment });
      this.emitDone(d.env_id, d.number);
    }
  }

  cancel(envId: string, number: number): Deployment {
    const { store } = this.ctx;
    const d = store.deployment(envId, number);
    if (!d) throw fail('not_found', `no deployment #${number}`);
    if (d.status === 'queued') {
      const out = store.updateDeployment(envId, number, { status: 'cancelled', finished_at: now() });
      this.emitDone(envId, number);
      return out;
    }
    if (!ACTIVE_STATUSES.includes(d.status)) throw fail('conflict', `deployment #${number} already finished (${d.status})`);
    const a = this.active.get(envId);
    if (a?.number === number && a.activating) {
      throw fail('conflict', `deployment #${number} is already switching traffic and cannot be cancelled`, 'wait for it to finish, then roll back');
    }
    this.cancelRequested.add(`${envId}:${number}`);
    return d;
  }

  // ---- supervisor → CP ---------------------------------------------------------

  onSupervisorStatus(env: EnvRow, s: SupervisorStatus): void {
    this.svStatus.set(`${env.id}:${s.deployment}`, { ...s, at: Date.now() });
    if (s.services) this.ctx.store.updateEnv(env.id, { services: JSON.stringify(s.services), services_at: now() });
    this.ctx.bus.publish(svTopic(env.id), s);
  }

  /** Supervisor log lines for the release being worked on are also deployment `log` events. */
  onLogs(env: EnvRow, lines: LogLine[]): void {
    const a = this.active.get(env.id);
    if (!a || a.release === null) return;
    for (const l of lines) {
      if (l.deployment === a.release) this.emit(env.id, a.number, 'log', { ts: l.ts, source: l.source, line: l.line });
    }
  }

  // ---- events --------------------------------------------------------------------

  emit(envId: string, number: number, event: string, data: unknown): void {
    const seq = this.ctx.store.insertEvent(envId, number, event, data);
    this.ctx.bus.publish(depTopic(envId, number), { seq, event, data });
  }

  private emitDone(envId: string, number: number): void {
    const { store } = this.ctx;
    const d = store.deployment(envId, number)!;
    const env = store.envById(envId)!;
    const app = store.appById(env.app_id)!;
    this.emit(envId, number, 'done', { status: d.status, deployment: deploymentView(this.ctx, app, env, d) });
  }

  // ---- job ---------------------------------------------------------------------

  private async run(envId: string, number: number): Promise<void> {
    const { store } = this.ctx;
    const dep = store.deployment(envId, number);
    if (!dep || dep.status !== 'queued') return;
    const env = store.envById(envId);
    const app = env ? store.appById(env.app_id) : undefined;
    if (!env || !app) return;
    this.active.set(envId, { number, release: null, activating: false });
    const job = new Job(this.ctx, this, app, envId, dep);
    try {
      store.updateDeployment(envId, number, { status: dep.kind === 'rollback' ? 'starting' : 'building', started_at: now() });
      let release: number | null;
      if (dep.kind === 'deploy') release = await this.deploy(job);
      else if (dep.kind === 'apply') release = await this.apply(job);
      else release = await this.rollback(job);
      const url = this.ctx.resources.appUrl(app.name, env.name);
      await job.step('live', async () => undefined, { detail: url });
      this.finishLive(job, release);
    } catch (err) {
      this.finishFailed(job, err);
    } finally {
      this.active.delete(envId);
      this.cancelRequested.delete(`${envId}:${number}`);
    }
  }

  isCancelled(envId: string, number: number): boolean {
    return this.cancelRequested.has(`${envId}:${number}`);
  }

  setRelease(envId: string, release: number, activating = false): void {
    const a = this.active.get(envId);
    if (a) {
      a.release = release;
      a.activating = activating;
    }
  }

  private finishLive(job: Job, release: number | null): void {
    const { store } = this.ctx;
    const env = store.envById(job.envId)!;
    const replaced = job.dep.kind === 'rollback' ? 'rolled_back' : 'superseded';
    store.tx(() => {
      if (env.live_deployment && env.live_deployment !== job.dep.number) {
        store.updateDeployment(env.id, env.live_deployment, { status: replaced });
      }
      store.updateDeployment(env.id, job.dep.number, { status: 'live', finished_at: now(), live_at: now(), release, box_id: env.box_id });
      store.updateEnv(env.id, { live_deployment: job.dep.number, requested_deployment: job.dep.number });
    });
    job.log(`deployment #${job.dep.number} is live at ${this.ctx.resources.appUrl(job.app.name, env.name)}`);
    this.emitDone(env.id, job.dep.number);
  }

  private finishFailed(job: Job, err: unknown): void {
    const { store } = this.ctx;
    const env = store.envById(job.envId)!;
    const cancelled = err instanceof Cancelled;
    let error: DeploymentError | null = null;
    if (!cancelled) {
      const step = err instanceof StepFailure ? err.step : (job.currentStep ?? 'deploy');
      const message = err instanceof Error ? err.message : String(err);
      const tail = err instanceof StepFailure && err.logTail?.length ? err.logTail : logTail(this.ctx, env, store.deployment(env.id, job.dep.number)!, 20);
      error = { step, message, log_tail: tail };
      const details = err instanceof StepFailure && err.cause instanceof HttpError ? err.cause.details : undefined;
      if (details && Array.isArray(details.errors)) (error as DeploymentError & { errors?: unknown }).errors = details.errors;
      job.log(`failed at ${step}: ${message}`, 'error');
    } else {
      job.log('cancelled');
    }
    // The supervisor must not pick this deployment up again on its next boot.
    store.updateEnv(env.id, { requested_deployment: env.live_deployment });
    store.updateDeployment(env.id, job.dep.number, { status: cancelled ? 'cancelled' : 'failed', finished_at: now(), error });
    this.emitDone(env.id, job.dep.number);
  }

  // ---- kinds -------------------------------------------------------------------

  /**
   * deploy: check → upload → database → box → build → migrate → start → live.
   *
   * Build-then-migrate-then-activate: the build runs in a fresh release dir while the old release
   * keeps serving, so a broken build never touches the database. Migrations run only once the new
   * code is known to build, and before it starts, so new code never sees the old schema. The old
   * code keeps serving during the migration, which is why migrations must stay backward compatible
   * for one release. A restore point is recorded right before the first pending migration.
   */
  private async deploy(job: Job): Promise<number> {
    const { store, resources, supervisor, timing } = this.ctx;
    const manifest = job.manifest();
    const snapshot = store.snapshot(job.app.id, job.dep.snapshot_id ?? '');
    if (!snapshot) throw new StepFailure('check', `snapshot ${job.dep.snapshot_id} not found`);

    const migrations = await job.step('check', async () => {
      await this.checkSnapshot(job, manifest, snapshot.manifest);
      return this.migrationsFromSnapshot(job, manifest, snapshot.manifest);
    }, { detail: 'boxlite.toml and project files' });
    await job.step('upload', async () => undefined, { detail: `${snapshot.files} files, ${formatMb(snapshot.bytes)} (${snapshot.id.slice(0, 17)})` });

    const db = manifest.database ? await this.databaseStep(job) : null;

    const size = BOX_SIZES[manifest.runtime.size];
    const env = await job.step(
      'box',
      () => resources.ensureBox(job.app, job.envId, { image: manifest.runtime.image, size: manifest.runtime.size, volumes: manifest.volumes }, job.dep.number, (l) => job.log(l)),
      { detail: `${manifest.runtime.image}/${manifest.runtime.size}${size ? ` (${size.cpus} CPU, ${size.memory_mib / 1024} GB)` : ''}`, done: (e) => `${e.box_id} ${e.box_url ?? ''}`.trim() },
    );
    const spec = this.writeSpec(job, manifest, db, migrations);
    job.log(`spec v${spec.version} written`);

    const n = job.dep.number;
    await job.step(
      'build',
      async () => {
        store.updateDeployment(env.id, n, { box_id: env.box_id });
        store.updateEnv(env.id, { requested_deployment: n });
        this.setRelease(env.id, n);
        this.svStatus.delete(`${env.id}:${n}`);
        await this.svCall('build', n, () => supervisor.deploy(env.box_url!, env.control_secret, n));
        const s = await this.waitPhase(env.id, n, ['built', 'failed'], timing.buildMs, 'build');
        if (s.phase === 'failed') throw new StepFailure(s.step ?? 'build', s.error ?? 'build failed', s.log_tail);
        store.updateDeployment(env.id, n, { built: true });
      },
      { detail: manifest.runtime.build.length ? manifest.runtime.build.join(' && ') : 'no build steps' },
    );

    if (db) await this.migrateStep(job, db.url, migrations);
    job.checkCancelled();

    await job.step(
      'start',
      async () => {
        this.setRelease(env.id, n, true);
        this.svStatus.delete(`${env.id}:${n}`);
        await this.svCall('start', n, () => supervisor.activate(env.box_url!, env.control_secret, n));
        return this.waitLive(env.id, n);
      },
      { status: 'starting', detail: serviceNames(manifest), done: (s) => serviceSummary(s, manifest) },
    );
    return n;
  }

  /**
   * apply: config-only change (database, variables, access, …) without a new build.
   * On a live env the services are restarted by "rolling back" to the release that is already
   * current: the supervisor re-reads the spec (with the new env) and health-gates the restart, and
   * no new release dir is needed. That is the cheapest restart that still has a health gate.
   */
  private async apply(job: Job): Promise<number | null> {
    const { store, resources, supervisor } = this.ctx;
    const manifest = job.manifest();
    // An apply runs the live release's code with new configuration: record that code's snapshot, so
    // `deployments/{n}/source` (and `app clone`) works for an apply like for the deploy it restarts.
    const running = store.envById(job.envId)!.live_deployment;
    const code = running ? store.deployment(job.envId, running) : undefined;
    if (code?.snapshot_id && code.snapshot_id !== job.dep.snapshot_id) store.updateDeployment(job.envId, job.dep.number, { snapshot_id: code.snapshot_id });
    const migrations = job.dep.request.migrations ?? [];
    job.recordMigrations(migrations);

    const db = manifest.database ? await this.databaseStep(job) : null;
    const spec = this.writeSpec(job, manifest, db, migrations);
    job.log(`spec v${spec.version} written`);
    if (db) await this.migrateStep(job, db.url, migrations);
    job.checkCancelled();

    const env = store.envById(job.envId)!;
    const live = env.live_deployment ? store.deployment(env.id, env.live_deployment) : undefined;
    if (!env.box_id || !live?.release) {
      job.log('no running release yet; the next deploy starts services with this configuration');
      return null;
    }
    if (env.box_image !== manifest.runtime.image || env.box_size !== manifest.runtime.size) {
      job.log('runtime image/size changes take effect on the next deploy');
    }
    const release = live.release;
    await job.step(
      'start',
      async () => {
        await resources.ensureRunning(env.id, (l) => job.log(l));
        store.updateEnv(env.id, { requested_deployment: job.dep.number });
        this.setRelease(env.id, release, true);
        this.svStatus.delete(`${env.id}:${release}`);
        await this.svCall('start', release, () => supervisor.rollback(env.box_url!, env.control_secret, release));
        return this.waitLive(env.id, release);
      },
      { status: 'starting', detail: `restart release #${release} with the new configuration`, done: (s) => serviceSummary(s, manifest) },
    );
    return release;
  }

  /** rollback to #N: N's spec as a new version, optional database restore, switch to N's release dir. */
  private async rollback(job: Job): Promise<number> {
    const { store, resources, supervisor, neon } = this.ctx;
    const to = job.dep.request.to!;
    const target = store.deployment(job.envId, to);
    if (!target?.release || !target.spec_version) throw new StepFailure('check', `deployment #${to} has no release to roll back to`);
    const targetSpec = store.spec(job.envId, target.spec_version)!;
    const release = target.release;

    if (job.dep.request.with_database) {
      const ts = this.restoreTimestampFor(job.envId, to);
      await job.step(
        'database',
        async () => {
          if (!ts) {
            job.log(`no migrations ran after #${to}; database left as is`);
            return;
          }
          const app = store.appById(job.app.id)!;
          const env = store.envById(job.envId)!;
          if (!app.neon_project_id || !env.neon_branch_id) throw new Error('this environment has no database');
          job.log(`restoring Neon branch ${env.neon_branch_id} to ${ts}`);
          await neon.restoreBranch(app.neon_project_id, env.neon_branch_id, ts, `${env.name}-before-rollback-${job.dep.number}`);
        },
        { detail: ts ? `restore to ${ts}` : 'no schema change since #' + to },
      );
    }

    const env = store.envById(job.envId)!;
    const version = store.latestSpecVersion(env.id) + 1;
    const spec: Spec = {
      ...targetSpec,
      version,
      deployment: job.dep.number,
      base_version: version - 1,
      assigned: { ...targetSpec.assigned, box_id: env.box_id, box_url: env.box_url, app_url: resources.appUrl(job.app.name, env.name) },
    };
    store.insertSpec(env.id, spec);
    store.updateDeployment(env.id, job.dep.number, { spec_version: version, snapshot_id: target.snapshot_id });
    job.log(`spec v${version} written (copy of v${target.spec_version} from #${to})`);
    job.checkCancelled();

    await job.step(
      'start',
      async () => {
        await resources.ensureRunning(env.id, (l) => job.log(l));
        store.updateEnv(env.id, { requested_deployment: job.dep.number });
        this.setRelease(env.id, release, true);
        this.svStatus.delete(`${env.id}:${release}`);
        await this.svCall('start', release, () => supervisor.rollback(env.box_url!, env.control_secret, release));
        return this.waitLive(env.id, release);
      },
      { status: 'starting', detail: `switch to release #${release}`, done: (s) => serviceSummary(s, targetSpec) },
    );
    return release;
  }

  private databaseStep(job: Job): Promise<{ url: string; host: string; branchId: string }> {
    const env = this.ctx.store.envById(job.envId)!;
    return job.step('database', () => this.ctx.resources.ensureDatabase(job.app.id, job.envId, (l) => job.log(l)), {
      detail: `neon branch ${env.name}`,
      done: (db) => `neon branch ${env.name} on ${db.host}`,
    });
  }

  private migrateStep(job: Job, url: string, files: MigrationFile[]): Promise<string> {
    return job.step('migrate', () => this.migrate(job, url, files), { status: 'migrating', detail: files.length ? `${files.length} migration file(s)` : 'no migration files', done: (d) => d });
  }

  /**
   * The database state that matches #N is the one right before the first later deployment changed
   * the schema, so restore to the earliest restore point recorded after N (none → nothing to undo).
   */
  restoreTimestampFor(envId: string, to: number): string | null {
    const row = this.ctx.store.get<{ ts: string | null }>('SELECT MIN(restore_point) AS ts FROM deployments WHERE env_id = ? AND number > ? AND restore_point IS NOT NULL', envId, to);
    return row?.ts ?? null;
  }

  /** Releases still on the env's Box: the supervisor keeps the newest 3 built release dirs plus `current` (failed builds are removed). */
  rollbackProblem(env: EnvRow, to: number): string | null {
    const { store } = this.ctx;
    const target = store.deployment(env.id, to);
    if (!target) return `no deployment #${to}`;
    if (!['live', 'superseded', 'rolled_back'].includes(target.status)) return `deployment #${to} never went live (${target.status})`;
    if (!target.release) return `deployment #${to} has no release (it ran before the first deploy)`;
    if (!env.box_id || target.box_id !== env.box_id) return `deployment #${to} ran on a Box that has since been replaced`;
    const live = env.live_deployment ? store.deployment(env.id, env.live_deployment) : undefined;
    const recent = store
      .deploymentsWhere("env_id = ? AND kind = 'deploy' AND built = 1 AND box_id = ? ORDER BY number DESC LIMIT 3", env.id, env.box_id)
      .map((d) => d.number);
    if (target.release !== live?.release && !recent.includes(target.release)) return `release #${target.release} has been pruned from the Box (only the newest 3 are kept)`;
    return null;
  }

  // ---- helpers -------------------------------------------------------------------

  private writeSpec(job: Job, manifest: Manifest, db: { host: string; branchId: string } | null, migrations: { file: string; sha256: string }[]): Spec {
    const { store, resources } = this.ctx;
    const env = store.envById(job.envId)!;
    const prev = store.spec(env.id);
    const version = (prev?.version ?? 0) + 1;
    const applied: AppliedMigration[] = [];
    if (manifest.database) {
      const before = new Map((prev?.database?.applied ?? []).map((a) => [a.file, a]));
      for (const m of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
        applied.push(before.get(m.file) ?? { file: m.file, sha256: m.sha256, deployment: job.dep.number });
      }
    }
    const spec = buildSpec({
      manifest,
      version,
      deployment: job.dep.number,
      baseVersion: job.dep.base_version ?? prev?.version ?? 0,
      applied,
      accessOverride: env.access_override,
      assigned: {
        box_id: env.box_id,
        box_url: env.box_url,
        db_host: db?.host ?? null,
        db_branch: db?.branchId ?? null,
        app_url: resources.appUrl(job.app.name, env.name),
      },
    });
    store.insertSpec(env.id, spec);
    store.updateDeployment(env.id, job.dep.number, { spec_version: version });
    return spec;
  }

  /** Runs pending migrations; returns the step detail, e.g. "0002_deals.sql (restore point created)". */
  private async migrate(job: Job, url: string, files: MigrationFile[]): Promise<string> {
    const { appdb, store } = this.ctx;
    if (job.manifest().auth) {
      // Before the app's own migrations, so their RLS policies can call boxlite.current_user_id().
      await ensureUserMirror(this.ctx, url);
      job.log('sign-in: boxlite.users and boxlite.current_user_id() ready');
    }
    // The role SQL reads run as. Reads also create it lazily, so a failure here never fails a deploy.
    try {
      await appdb.ensureReader(url);
    } catch (err) {
      job.log(`warning: could not prepare the read-only database role yet: ${(err as Error).message}`);
    }
    if (!files.length) {
      job.log('no migration files');
      return 'no migration files';
    }
    const applied = await appdb.listApplied(url);
    const { pending, changed } = classifyMigrations(files, applied);
    if (changed.length) {
      throw fail('invalid_manifest', `applied migration(s) changed: ${changed.join(', ')}`, 'never edit an applied migration; restore the file and add a new NNNN_*.sql instead');
    }
    if (!pending.length) {
      job.log('database schema is up to date');
      return 'schema up to date';
    }
    store.updateDeployment(job.envId, job.dep.number, { restore_point: now() });
    const byName = new Map(files.map((f) => [f.file, f]));
    for (const file of pending) {
      job.log(`applying migration ${file}`);
      await appdb.applyMigration(url, byName.get(file)!, job.dep.number);
    }
    job.log(`applied ${pending.length} migration(s)`);
    return `${pending.join(', ')} (restore point created)`;
  }

  private async waitLive(envId: string, release: number): Promise<SupervisorStatus> {
    const s = await this.waitPhase(envId, release, ['live', 'failed'], this.ctx.timing.activateMs, 'start');
    if (s.phase === 'failed') throw new StepFailure(s.step ?? 'start', s.error ?? 'services did not become healthy', s.log_tail);
    return s;
  }

  /**
   * POST /deploy, /activate or /rollback. The supervisor runs one build/activation at a time and
   * answers 409 deploy_in_progress meanwhile (e.g. its own boot-time reconcile), so that is retried
   * for up to the activation budget; not_built / not_found_release mean the release is not on the Box.
   */
  private async svCall(step: string, release: number, fn: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + this.ctx.timing.activateMs;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        let code = '';
        try {
          code = String((JSON.parse(err.body ?? '{}') as { error?: unknown }).error ?? '');
        } catch {
          // non-JSON body: keep the generic message
        }
        if (err.status === 409 && code === 'deploy_in_progress' && Date.now() < deadline) {
          await sleep(this.ctx.timing.pollMs);
          continue;
        }
        if (code === 'not_built') throw new StepFailure(step, `release #${release} is not built on the Box`, undefined, err);
        if (code === 'not_found_release') throw new StepFailure(step, `release #${release} is no longer on the Box (only the newest 3 are kept)`, undefined, err);
        if (code === 'deploy_in_progress') throw new StepFailure(step, 'the supervisor stayed busy with another build or activation', undefined, err);
        throw err;
      }
    }
  }

  /** Waits for the supervisor to report one of `phases` for `release`. */
  private waitPhase(envId: string, release: number, phases: string[], timeoutMs: number, step: string): Promise<SupervisorStatus> {
    const key = `${envId}:${release}`;
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const s = this.svStatus.get(key);
        if (s && phases.includes(s.phase)) {
          cleanup();
          resolve(s);
          return true;
        }
        return false;
      };
      const unsubscribe = this.ctx.bus.subscribe(svTopic(envId), () => void check());
      const timer = setTimeout(() => {
        cleanup();
        reject(new StepFailure(step, `the supervisor did not report ${phases.join('/')} for release ${release} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      const cleanup = () => {
        unsubscribe();
        clearTimeout(timer);
      };
      check();
    });
  }

  /** The CP re-runs the shared local check against the uploaded files, so a hand-made upload cannot skip it. */
  private async checkSnapshot(job: Job, manifest: Manifest, files: SnapshotFile[]): Promise<void> {
    const dir = mkdtempSync(join(this.ctx.config.dataDir, 'tmp', 'check-'));
    try {
      for (const f of files) {
        const dest = join(dir, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        try {
          linkSync(this.ctx.blobs.path(job.app.id, f.sha256), dest);
        } catch {
          copyFileSync(this.ctx.blobs.path(job.app.id, f.sha256), dest);
        }
      }
      const result = await Promise.resolve(checkLocal(dir, manifest));
      for (const w of result.warnings) job.log(`warning: ${w.message}`);
      if (!result.ok || result.errors.length) {
        throw fail('invalid_manifest', `check failed: ${result.errors.map((e) => e.message).join('; ')}`, 'run `boxlite-app check` and fix the errors', { errors: result.errors });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** migrations/*.sql of the snapshot (top level of the migrations dir only, like the CLI). */
  private async migrationsFromSnapshot(job: Job, manifest: Manifest, files: SnapshotFile[]): Promise<MigrationFile[]> {
    if (!manifest.database) return [];
    const dir = manifest.database.migrations.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    const out: MigrationFile[] = [];
    for (const f of files) {
      const rel = dir ? (f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1) : null) : f.path;
      if (!rel || rel.includes('/') || !MIGRATION_FILE_RE_CP.test(rel)) continue;
      const sql = (await buffer(this.ctx.blobs.read(job.app.id, f.sha256))).toString('utf8');
      out.push({ file: rel, sha256: f.sha256, sql });
    }
    out.sort((a, b) => a.file.localeCompare(b.file));
    job.recordMigrations(out);
    return out;
  }
}

/** One running deployment: step bookkeeping, logs, cancellation. */
class Job {
  currentStep: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly orch: Orchestrator,
    readonly app: AppRow,
    readonly envId: string,
    readonly dep: Deployment,
  ) {}

  manifest(): Manifest {
    const m = this.dep.request.manifest;
    if (!m) throw new StepFailure('check', 'deployment request carries no manifest');
    return m;
  }

  log(line: string, level: 'info' | 'error' = 'info'): void {
    const entry: LogLine = { ts: now(), source: 'system', level, line, deployment: this.dep.number };
    recordLogs(this.ctx, this.envId, [entry]);
    this.orch.emit(this.envId, this.dep.number, 'log', { ts: entry.ts, source: 'system', line });
  }

  /** Keeps the migration list (without SQL) for GET /db/migrations. */
  recordMigrations(files: { file: string; sha256: string }[]): void {
    const request = { ...this.dep.request, resolved_migrations: files.map((f) => ({ file: f.file, sha256: f.sha256 })) };
    this.ctx.store.updateDeployment(this.envId, this.dep.number, { request });
  }

  checkCancelled(): void {
    if (this.orch.isCancelled(this.envId, this.dep.number)) throw new Cancelled();
  }

  /**
   * Runs one named step: persists it in Deployment.steps and emits `step` events. `detail` is a
   * human line the CLI prints as-is; `done` may refine it from the step's result.
   */
  async step<T>(name: string, fn: () => Promise<T>, opts: { status?: DeploymentStatus; detail?: string; done?: (out: T) => string | undefined } = {}): Promise<T> {
    this.checkCancelled();
    const { store } = this.ctx;
    this.currentStep = name;
    const started = Date.now();
    const d = store.deployment(this.envId, this.dep.number)!;
    const running: Step = { name, status: 'running', ...(opts.detail ? { detail: opts.detail } : {}) };
    store.updateDeployment(this.envId, this.dep.number, { steps: [...d.steps, running], ...(opts.status ? { status: opts.status } : {}) });
    this.orch.emit(this.envId, this.dep.number, 'step', running);
    const mark = (st: Step['status'], detail: string | undefined) => {
      const ms = Date.now() - started;
      const ev: Step = { name, status: st, ms, ...(detail ? { detail } : {}) };
      const cur = store.deployment(this.envId, this.dep.number)!;
      store.updateDeployment(this.envId, this.dep.number, { steps: cur.steps.map((s) => (s.name === name && s.status === 'running' ? ev : s)) });
      this.orch.emit(this.envId, this.dep.number, 'step', ev);
    };
    try {
      const out = await fn();
      let detail = opts.detail;
      try {
        detail = opts.done?.(out) ?? detail;
      } catch {
        // a detail formatter must never fail the step
      }
      mark('done', detail);
      return out;
    } catch (err) {
      mark('failed', err instanceof Error ? err.message.slice(0, 300) : undefined);
      if (err instanceof StepFailure || err instanceof Cancelled) throw err;
      const tail = err instanceof HttpError && Array.isArray(err.details.log_tail) ? (err.details.log_tail as string[]) : undefined;
      throw new StepFailure(name, err instanceof Error ? err.message : String(err), tail, err);
    }
  }
}

function formatMb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function serviceNames(m: Pick<Manifest, 'services'>): string {
  return m.services.map((s) => s.name).join(', ') || 'no services';
}

/** "web :3000 healthy · worker running · 1 schedule" from the supervisor's live report. */
function serviceSummary(s: SupervisorStatus, m: Pick<Manifest, 'services' | 'schedules'>): string {
  const parts = (s.services ?? []).map((sv) => {
    if (sv.port) return `${sv.name} :${sv.port} ${sv.health && sv.health !== 'none' ? sv.health : sv.state}`;
    return `${sv.name} ${sv.state}`;
  });
  if (!parts.length) parts.push(serviceNames(m));
  if (m.schedules.length) parts.push(`${m.schedules.length} schedule${m.schedules.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
