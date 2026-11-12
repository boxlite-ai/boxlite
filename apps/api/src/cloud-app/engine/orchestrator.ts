/** The deployment queue and runner: one queue per env, cancellation, CP-restart recovery, finishing a deployment as live or failed. */
import type { Deployment, DeploymentError, EnvRow, LogLine, Step } from './db'
import { ACTIVE_STATUSES, now } from './db'
import type { Ctx } from './ctx'
import { HttpError, fail } from './errors'
import { depTopic } from './events'
import type { SupervisorStatus } from './supervisor'
import { deploymentView, logTail } from './views'
import { runApply } from './orchestrator/apply'
import { runDeploy } from './orchestrator/deploy'
import { Cancelled, Job, StepFailure, type JobHost } from './orchestrator/job'
import { rollbackProblem, runRollback } from './orchestrator/rollback'
import { SupervisorLink } from './orchestrator/supervisor-link'
import { capturePreview } from './preview'

/**
 * Runs deployments. One queue per env: a deployment starts only when the previous one in that env
 * finished, so `queued` really means "waiting for the env", and two deployments never race for the
 * same Box or database branch.
 */
export class Orchestrator implements JobHost {
  /** env → the deployment being worked on and the release number the supervisor was told to run. */
  private readonly active = new Map<string, { number: number; release: number | null; activating: boolean }>()
  private readonly sv: SupervisorLink

  constructor(private readonly ctx: Ctx) {
    this.sv = new SupervisorLink(ctx)
  }

  // ---- queue -----------------------------------------------------------------

  /** HTTP handlers persist queued rows; only a platform worker executes them. */
  enqueue(_envId: string, _number: number): void {}

  /** Called while the platform worker owns this environment's renewable lease. */
  async runQueued(envId?: string, signal?: AbortSignal): Promise<void> {
    const queued = await this.ctx.store.deploymentsWhere(
      envId
        ? "env_id = ? AND status = 'queued' ORDER BY number LIMIT 1"
        : "status = 'queued' ORDER BY created_at LIMIT 1",
      ...(envId ? [envId] : []),
    )
    for (const dep of queued) {
      signal?.throwIfAborted()
      await this.run(dep.env_id, dep.number, signal)
    }
  }

  /** Recover only an environment whose previous worker lease has expired. */
  async recover(envId: string): Promise<void> {
    const deps = await this.ctx.store.deploymentsWhere(
      "env_id = ? AND status IN ('uploading','building','migrating','starting')",
      envId,
    )
    for (const dep of deps) {
      await this.ctx.store.updateDeployment(envId, dep.number, {
        status: 'failed',
        finished_at: now(),
        steps: dep.steps.map((step) => (step.status === 'running' ? { ...step, status: 'failed' as const } : step)),
        error: { step: 'worker', message: 'deployment worker stopped before this deployment finished' },
      })
      const env = await this.ctx.store.envById(envId)
      if (env) await this.ctx.store.updateEnv(envId, { requested_deployment: env.live_deployment })
      await this.emitDone(envId, dep.number)
    }
  }

  async cancel(envId: string, number: number): Promise<Deployment> {
    const { store } = this.ctx
    const d = await store.deployment(envId, number)
    if (!d) throw fail('not_found', `no deployment #${number}`)
    if (d.status === 'queued') {
      const out = await store.updateDeployment(envId, number, { status: 'cancelled', finished_at: now() })
      await this.emitDone(envId, number)
      return out
    }
    if (!ACTIVE_STATUSES.includes(d.status))
      throw fail('conflict', `deployment #${number} already finished (${d.status})`)
    const a = this.active.get(envId)
    if (a?.number === number && a.activating) {
      throw fail(
        'conflict',
        `deployment #${number} is already switching traffic and cannot be cancelled`,
        'wait for it to finish, then roll back',
      )
    }
    await store.run('UPDATE deployments SET cancel_requested = TRUE WHERE env_id = ? AND number = ?', envId, number)
    return d
  }

  // ---- supervisor → CP ---------------------------------------------------------

  async onSupervisorStatus(env: EnvRow, s: SupervisorStatus): Promise<void> {
    await this.sv.report(env, s)
  }

  /** Supervisor log lines for the release being worked on are also deployment `log` events. */
  async onLogs(env: EnvRow, lines: LogLine[]): Promise<void> {
    const number = env.requested_deployment
    if (!number) return
    const dep = await this.ctx.store.deployment(env.id, number)
    if (!dep || !ACTIVE_STATUSES.includes(dep.status)) return
    const release = dep.kind === 'deploy' ? dep.number : dep.release
    for (const line of lines)
      if (line.deployment === release)
        await this.emit(env.id, number, 'log', { ts: line.ts, source: line.source, line: line.line })
  }

  // ---- events --------------------------------------------------------------------

  async emit(envId: string, number: number, event: string, data: unknown): Promise<void> {
    const seq = await this.ctx.store.insertEvent(envId, number, event, data)
    this.ctx.bus.publish(depTopic(envId, number), { seq, event, data })
  }

  private async emitDone(envId: string, number: number): Promise<void> {
    const { store } = this.ctx
    const d = (await store.deployment(envId, number))!
    const env = (await store.envById(envId))!
    const app = (await store.appById(env.app_id))!
    await this.emit(envId, number, 'done', {
      status: d.status,
      deployment: await deploymentView(this.ctx, app, env, d),
    })
  }

  // ---- job ---------------------------------------------------------------------

  async run(envId: string, number: number, signal?: AbortSignal): Promise<void> {
    const { store } = this.ctx
    const dep = await store.deployment(envId, number)
    if (!dep || dep.status !== 'queued') return
    const env = await store.envById(envId)
    const app = env ? await store.appById(env.app_id) : undefined
    if (!env || !app) return
    this.active.set(envId, { number, release: null, activating: false })
    const job = new Job(this.ctx, this, app, envId, dep, signal)
    try {
      await store.updateDeployment(envId, number, {
        status: dep.kind === 'rollback' ? 'starting' : 'building',
        started_at: now(),
      })
      let release: number | null
      if (dep.kind === 'deploy') release = await runDeploy(job, this.sv)
      else if (dep.kind === 'apply') release = await runApply(job, this.sv)
      else release = await runRollback(job, this.sv)
      const url = await this.ctx.resources.appUrl(app.name, env.name)
      await job.step('live', async () => undefined, { detail: url })
      await this.finishLive(job, release)
    } catch (err) {
      if (signal?.aborted) throw err
      await this.finishFailed(job, err)
    } finally {
      this.active.delete(envId)
    }
  }

  async isCancelled(envId: string, number: number): Promise<boolean> {
    const row = await this.ctx.store.get<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM deployments WHERE env_id = ? AND number = ?',
      envId,
      number,
    )
    return row?.cancel_requested === true
  }

  setRelease(envId: string, release: number, activating = false): void {
    const a = this.active.get(envId)
    if (a) {
      a.release = release
      a.activating = activating
    }
  }

  private async finishLive(job: Job, release: number | null): Promise<void> {
    job.signal?.throwIfAborted()
    const { store } = this.ctx
    const env = (await store.envById(job.envId))!
    const replaced = job.dep.kind === 'rollback' ? 'rolled_back' : 'superseded'
    await store.tx(async () => {
      if (env.live_deployment && env.live_deployment !== job.dep.number) {
        await store.updateDeployment(env.id, env.live_deployment, { status: replaced })
      }
      await store.updateDeployment(env.id, job.dep.number, {
        status: 'live',
        finished_at: now(),
        live_at: now(),
        release,
        box_id: env.active_box_id,
      })
      await store.updateEnv(env.id, { live_deployment: job.dep.number, requested_deployment: job.dep.number })
    })
    await job.log(`deployment #${job.dep.number} is live at ${await this.ctx.resources.appUrl(job.app.name, env.name)}`)
    await this.emitDone(env.id, job.dep.number)
    capturePreview(this.ctx, job.app.id, env.id, job.dep.number)
  }

  private async finishFailed(job: Job, err: unknown): Promise<void> {
    const { store } = this.ctx
    const env = (await store.envById(job.envId))!
    const cancelled = err instanceof Cancelled
    let error: DeploymentError | null = null
    if (!cancelled) {
      const step = err instanceof StepFailure ? err.step : (job.currentStep ?? 'deploy')
      const message = err instanceof Error ? err.message : String(err)
      const tail =
        err instanceof StepFailure && err.logTail?.length
          ? err.logTail
          : await logTail(this.ctx, env, (await store.deployment(env.id, job.dep.number))!, 20)
      error = { step, message, log_tail: tail }
      const details = err instanceof StepFailure && err.cause instanceof HttpError ? err.cause.details : undefined
      if (details && Array.isArray(details.errors))
        (error as DeploymentError & { errors?: unknown }).errors = details.errors
      await job.log(`failed at ${step}: ${message}`, 'error')
    } else {
      await job.log('cancelled')
    }
    // The supervisor must not pick this deployment up again on its next boot.
    await store.updateEnv(env.id, { requested_deployment: env.live_deployment })
    await store.updateDeployment(env.id, job.dep.number, {
      status: cancelled ? 'cancelled' : 'failed',
      finished_at: now(),
      error,
    })
    await this.emitDone(env.id, job.dep.number)
  }

  /** Why deployment #to of the env cannot be rolled back to, or null (orchestrator/rollback.ts). */
  async rollbackProblem(env: EnvRow, to: number): Promise<string | null> {
    return await rollbackProblem(this.ctx, env, to)
  }
}
