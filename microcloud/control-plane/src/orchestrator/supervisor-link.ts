/** The orchestrator's side of a supervisor build or activation: status reports in, control calls out (with retries), waiting for a phase. */
import type { EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { UpstreamError } from '../errors.js';
import { svTopic } from '../events.js';
import { sleep } from '../http.js';
import type { SupervisorStatus } from '../supervisor.js';
import { StepFailure } from './job.js';

export class SupervisorLink {
  /** `${envId}:${release}` → last status the supervisor reported for that release. */
  private readonly svStatus = new Map<string, SupervisorStatus & { at: number }>();

  constructor(private readonly ctx: Ctx) {}

  /** POST /sv/v1/status from the supervisor: remembered per release, services stored, waiters woken. */
  report(env: EnvRow, s: SupervisorStatus): void {
    this.svStatus.set(`${env.id}:${s.deployment}`, { ...s, at: Date.now() });
    if (s.services) this.ctx.store.updateEnv(env.id, { services: JSON.stringify(s.services), services_at: now() });
    this.ctx.bus.publish(svTopic(env.id), s);
  }

  /** Drops the last report for a release, before asking the supervisor to work on it again. */
  forget(envId: string, release: number): void {
    this.svStatus.delete(`${envId}:${release}`);
  }

  async waitLive(envId: string, release: number): Promise<SupervisorStatus> {
    const s = await this.waitPhase(envId, release, ['live', 'failed'], this.ctx.timing.activateMs, 'start');
    if (s.phase === 'failed') throw new StepFailure(s.step ?? 'start', s.error ?? 'services did not become healthy', s.log_tail);
    return s;
  }

  /**
   * POST /deploy, /activate or /rollback. The supervisor runs one build/activation at a time and
   * answers 409 deploy_in_progress meanwhile (e.g. its own boot-time reconcile), so that is retried
   * for up to the activation budget; not_built / not_found_release mean the release is not on the Box.
   */
  async call(step: string, release: number, fn: () => Promise<void>): Promise<void> {
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
  waitPhase(envId: string, release: number, phases: string[], timeoutMs: number, step: string): Promise<SupervisorStatus> {
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
}
