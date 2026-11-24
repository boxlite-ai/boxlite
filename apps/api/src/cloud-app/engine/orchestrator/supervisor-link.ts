/** The orchestrator's side of a supervisor build or activation: status reports in, control calls out (with retries), waiting for a phase. */
import type { EnvRow } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { UpstreamError } from '../errors'
import { svTopic } from '../events'
import { sleep } from '../http'
import type { SupervisorStatus } from '../supervisor'
import { StepFailure } from './job'

export class SupervisorLink {
  /** `${envId}:${release}` → last status the supervisor reported for that release. */

  constructor(private readonly ctx: Ctx) {}

  /** POST /sv/v1/status from the supervisor: remembered per release, services stored, waiters woken. */
  async report(env: EnvRow, s: SupervisorStatus): Promise<void> {
    await this.ctx.store.run(
      'INSERT INTO supervisor_status (env_id, release, status, updated_at) VALUES (?, ?, ?::jsonb, ?) ON CONFLICT(env_id, release) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at',
      env.id,
      s.deployment,
      JSON.stringify(s),
      now(),
    )
    if (s.services) await this.ctx.store.updateEnv(env.id, { services: JSON.stringify(s.services), services_at: now() })
    this.ctx.bus.publish(svTopic(env.id), s)
  }

  /** Drops the last report for a release, before asking the supervisor to work on it again. */
  async forget(envId: string, release: number): Promise<void> {
    await this.ctx.store.run('DELETE FROM supervisor_status WHERE env_id = ? AND release = ?', envId, release)
  }

  async waitLive(envId: string, release: number, signal?: AbortSignal): Promise<SupervisorStatus> {
    const s = await this.waitPhase(envId, release, ['live', 'failed'], this.ctx.timing.activateMs, 'start', signal)
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
  ): Promise<SupervisorStatus> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const row = await this.ctx.store.get<{ status: SupervisorStatus }>(
        'SELECT status FROM supervisor_status WHERE env_id = ? AND release = ?',
        envId,
        release,
      )
      if (row && phases.includes(row.status.phase)) return row.status
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
