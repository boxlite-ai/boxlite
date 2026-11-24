/** The orchestrator's side of a supervisor build or activation: status reports in, control calls out (with retries), waiting for a phase. */
import type { EnvRow } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { UpstreamError } from '../errors'
import { svTopic } from '../events'
import { sleep } from '../http'
import type { ActivationTarget, SupervisorStatus } from '../supervisor'
import { StepFailure } from './job'

export class SupervisorLink {
  constructor(private readonly ctx: Ctx) {}

  /** Apply and rollback record status under their operation number, separate from the reused release. */
  async report(env: EnvRow, s: SupervisorStatus): Promise<void> {
    const pending = `SELECT 1 FROM envs e JOIN deployments d ON d.env_id = e.id AND d.number = e.requested_deployment
                     WHERE e.id = ? AND d.release = ? AND d.status = 'starting' AND d.kind IN ('apply', 'rollback')`
    const scoped = s.operation !== undefined || s.spec_version !== undefined
    const match = scoped ? `EXISTS (${pending} AND d.number = ? AND d.spec_version = ?)` : `NOT EXISTS (${pending})`
    const saved = await this.ctx.store.run(
      `INSERT INTO supervisor_status (env_id, release, status, updated_at) SELECT ?::text, ?::int, ?::jsonb, ?::timestamptz WHERE ${match}
       ON CONFLICT (env_id, release) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at RETURNING release`,
      env.id,
      s.operation ?? s.deployment,
      JSON.stringify(s),
      now(),
      env.id,
      s.deployment,
      ...(scoped ? [s.operation ?? null, s.spec_version ?? null] : []),
    )
    if (!saved.changes) return
    if (s.services) await this.ctx.store.updateEnv(env.id, { services: JSON.stringify(s.services), services_at: now() })
    this.ctx.bus.publish(svTopic(env.id), s)
  }

  /** Drops the last report for the deployment operation before retrying it. */
  async forget(envId: string, operation: number): Promise<void> {
    await this.ctx.store.run('DELETE FROM supervisor_status WHERE env_id = ? AND release = ?', envId, operation)
  }

  async waitLive(
    envId: string,
    release: number,
    signal?: AbortSignal,
    target?: ActivationTarget,
  ): Promise<SupervisorStatus> {
    const s = await this.waitPhase(
      envId,
      release,
      ['live', 'failed'],
      this.ctx.timing.activateMs,
      'start',
      signal,
      target,
    )
    if (s.phase === 'failed')
      throw new StepFailure(s.step ?? 'start', s.error ?? 'services did not become healthy', s.log_tail)
    return s
  }

  /**
   * POST /deploy, /activate or /rollback. The supervisor runs one build/activation at a time and
   * answers 409 deploy_in_progress meanwhile (e.g. its own boot-time reconcile), so that is retried
   * for up to the activation budget; not_built / not_found_release mean the release is not on the Box.
   */
  async call(step: string, release: number, fn: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.ctx.timing.activateMs
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await fn()
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err
        let code = ''
        try {
          code = String((JSON.parse(err.body ?? '{}') as { error?: unknown }).error ?? '')
        } catch {
          // non-JSON body: keep the generic message
        }
        if (err.status === 409 && code === 'deploy_in_progress' && Date.now() < deadline) {
          await sleep(this.ctx.timing.pollMs)
          continue
        }
        if (code === 'not_built')
          throw new StepFailure(step, `release #${release} is not built on the Box`, undefined, err)
        if (code === 'not_found_release')
          throw new StepFailure(
            step,
            `release #${release} is no longer on the Box (only the newest 3 are kept)`,
            undefined,
            err,
          )
        if (code === 'deploy_in_progress')
          throw new StepFailure(step, 'the supervisor stayed busy with another build or activation', undefined, err)
        throw err
      }
    }
  }

  /** Waits for the supervisor to report one of `phases` for `release`. */
  async waitPhase(
    envId: string,
    release: number,
    phases: string[],
    timeoutMs: number,
    step: string,
    signal?: AbortSignal,
    target?: ActivationTarget,
  ): Promise<SupervisorStatus> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const row = await this.ctx.store.get<{ status: SupervisorStatus }>(
        'SELECT status FROM supervisor_status WHERE env_id = ? AND release = ?',
        envId,
        target?.operation ?? release,
      )
      if (
        row &&
        phases.includes(row.status.phase) &&
        (!target || (row.status.operation === target.operation && row.status.spec_version === target.spec_version))
      )
        return row.status
      await sleep(this.ctx.timing.pollMs)
    }
    throw new StepFailure(
      step,
      'the supervisor did not report ' +
        phases.join('/') +
        ' for release ' +
        release +
        ' within ' +
        Math.round(timeoutMs / 1000) +
        ' s',
    )
  }
}
