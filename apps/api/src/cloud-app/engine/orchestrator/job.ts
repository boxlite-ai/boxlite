/** One running deployment (Job): step bookkeeping, system log lines, cancellation; and the errors a step fails with. */
import type { Manifest } from '@boxlite-ai/cloud-app-shared'
import type { AppRow, Deployment, DeploymentStatus, LogLine, Step } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { HttpError } from '../errors'
import { recordLogs } from '../logsink'

export class Cancelled extends Error {}

/** A failure with the step it belongs to, for Deployment.error. */
export class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly logTail?: string[],
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/** What a Job needs from the orchestrator that runs it. */
export interface JobHost {
  emit(envId: string, number: number, event: string, data: unknown): Promise<void>
  isCancelled(envId: string, number: number): Promise<boolean>
  setRelease(envId: string, release: number, activating?: boolean): void
}

/** One running deployment: step bookkeeping, logs, cancellation. */
export class Job {
  currentStep: string | null = null

  constructor(
    readonly ctx: Ctx,
    private readonly host: JobHost,
    readonly app: AppRow,
    readonly envId: string,
    readonly dep: Deployment,
    readonly signal?: AbortSignal,
  ) {}

  manifest(): Manifest {
    const m = this.dep.request.manifest
    if (!m) throw new StepFailure('check', 'deployment request carries no manifest')
    return m
  }

  async log(line: string, level: 'info' | 'error' = 'info'): Promise<void> {
    const entry: LogLine = { ts: now(), source: 'system', level, line, deployment: this.dep.number }
    await recordLogs(this.ctx, this.envId, [entry])
    await this.host.emit(this.envId, this.dep.number, 'log', { ts: entry.ts, source: 'system', line })
  }

  /** Keeps the migration list (without SQL) for GET /db/migrations. */
  async recordMigrations(files: { file: string; sha256: string }[]): Promise<void> {
    const request = { ...this.dep.request, resolved_migrations: files.map((f) => ({ file: f.file, sha256: f.sha256 })) }
    await this.ctx.store.updateDeployment(this.envId, this.dep.number, { request })
  }

  /** Tells the orchestrator which release the supervisor is working on (supervisor log lines become `log` events). */
  setRelease(release: number, activating = false): void {
    this.host.setRelease(this.envId, release, activating)
  }

  async checkCancelled(): Promise<void> {
    this.signal?.throwIfAborted()
    if (await this.host.isCancelled(this.envId, this.dep.number)) throw new Cancelled()
  }

  /**
   * Runs one named step: persists it in Deployment.steps and emits `step` events. `detail` is a
   * human line the CLI prints as-is; `done` may refine it from the step's result.
   */
  async step<T>(
    name: string,
    fn: () => Promise<T>,
    opts: { status?: DeploymentStatus; detail?: string; done?: (out: T) => string | undefined } = {},
  ): Promise<T> {
    await this.checkCancelled()
    const { store } = this.ctx
    this.currentStep = name
    const started = Date.now()
    const d = (await store.deployment(this.envId, this.dep.number))!
    const running: Step = { name, status: 'running', ...(opts.detail ? { detail: opts.detail } : {}) }
    await store.updateDeployment(this.envId, this.dep.number, {
      steps: [...d.steps, running],
      ...(opts.status ? { status: opts.status } : {}),
    })
    await this.host.emit(this.envId, this.dep.number, 'step', running)
    const mark = async (st: Step['status'], detail: string | undefined) => {
      const ms = Date.now() - started
      const ev: Step = { name, status: st, ms, ...(detail ? { detail } : {}) }
      const cur = (await store.deployment(this.envId, this.dep.number))!
      await store.updateDeployment(this.envId, this.dep.number, {
        steps: cur.steps.map((s) => (s.name === name && s.status === 'running' ? ev : s)),
      })
      await this.host.emit(this.envId, this.dep.number, 'step', ev)
    }
    try {
      this.signal?.throwIfAborted()
      const out = await fn()
      this.signal?.throwIfAborted()
      let detail = opts.detail
      try {
        detail = opts.done?.(out) ?? detail
      } catch {
        // a detail formatter must never fail the step
      }
      await mark('done', detail)
      return out
    } catch (err) {
      if (this.signal?.aborted) throw err
      await mark('failed', err instanceof Error ? err.message.slice(0, 300) : undefined)
      if (err instanceof StepFailure || err instanceof Cancelled) throw err
      const tail =
        err instanceof HttpError && Array.isArray(err.details.log_tail) ? (err.details.log_tail as string[]) : undefined
      throw new StepFailure(name, err instanceof Error ? err.message : String(err), tail, err)
    }
  }
}
