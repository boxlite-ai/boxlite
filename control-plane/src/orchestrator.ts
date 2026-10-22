/** The deployment queue and runner: one queue per env, cancellation, CP-restart recovery, finishing a deployment as live or failed. */
import type { Deployment, DeploymentError, EnvRow, LogLine, Step } from './db.js';
import { ACTIVE_STATUSES, now } from './db.js';
import type { Ctx } from './ctx.js';
import { HttpError, fail } from './errors.js';
import { depTopic } from './events.js';
import type { SupervisorStatus } from './supervisor.js';
import { deploymentView, logTail } from './views.js';
import { runApply } from './orchestrator/apply.js';
import { runDeploy } from './orchestrator/deploy.js';
import { Cancelled, Job, StepFailure, type JobHost } from './orchestrator/job.js';
import { rollbackProblem, runRollback } from './orchestrator/rollback.js';
import { SupervisorLink } from './orchestrator/supervisor-link.js';
import { capturePreview } from './preview.js';

/**
 * Runs deployments. One queue per env: a deployment starts only when the previous one in that env
 * finished, so `queued` really means "waiting for the env", and two deployments never race for the
 * same Box or database branch.
 */
export class Orchestrator implements JobHost {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  /** env → the deployment being worked on and the release number the supervisor was told to run. */
  private readonly active = new Map<string, { number: number; release: number | null; activating: boolean }>();
  private readonly sv: SupervisorLink;

  constructor(private readonly ctx: Ctx) {
    this.sv = new SupervisorLink(ctx);
  }

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
    this.sv.report(env, s);
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
      if (dep.kind === 'deploy') release = await runDeploy(job, this.sv);
      else if (dep.kind === 'apply') release = await runApply(job, this.sv);
      else release = await runRollback(job, this.sv);
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
    capturePreview(this.ctx, job.app.id, env.id, job.dep.number);
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

  /** Why deployment #to of the env cannot be rolled back to, or null (orchestrator/rollback.ts). */
  rollbackProblem(env: EnvRow, to: number): string | null {
    return rollbackProblem(this.ctx, env, to);
  }
}
