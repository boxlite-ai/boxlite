import { classifyFailure, MicrocloudError, type FailureInput } from '@microcloud/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventData, type Api, type Deployment, type DoneEvent, type LogEvent, type StepEvent } from './api.js';

export const TERMINAL_STATUSES = new Set(['live', 'failed', 'cancelled', 'superseded', 'rolled_back']);

export interface FollowHandlers {
  onStep?: (ev: StepEvent) => void;
  onLog?: (ev: LogEvent) => void;
}

export type FollowResult = { aborted: true } | { aborted: false; status: string; deployment: Deployment };

const MAX_RECONNECTS = 10;
const POLL_MS = 2000;

/**
 * Follows `/deployments/{n}/events` until `done`. A dropped stream is resumed with `Last-Event-ID`;
 * if the stream keeps dropping the deployment is polled instead. Aborting the signal (Ctrl-C) only
 * stops following — the deployment keeps running on the control plane.
 */
export async function followDeployment(api: Api, n: number, handlers: FollowHandlers = {}, signal?: AbortSignal): Promise<FollowResult> {
  let lastEventId: string | undefined;
  for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt++) {
    if (signal?.aborted) return { aborted: true };
    try {
      for await (const ev of api.deploymentEvents(n, { signal, lastEventId })) {
        if (ev.id !== undefined) lastEventId = ev.id;
        if (ev.event === 'step') {
          const step = eventData<StepEvent>(ev);
          if (step) handlers.onStep?.(step);
        } else if (ev.event === 'log') {
          const log = eventData<LogEvent>(ev);
          if (log) handlers.onLog?.(log);
        } else if (ev.event === 'done') {
          const done = eventData<DoneEvent>(ev);
          const deployment = done?.deployment ?? (await api.getDeployment(n));
          return { aborted: false, status: done?.status ?? deployment.status, deployment };
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || signal?.aborted) return { aborted: true };
      if (!(e instanceof MicrocloudError && e.code === 'unavailable')) throw e;
    }
    // Stream ended without `done`: check whether the deployment finished meanwhile.
    const current = await api.getDeployment(n);
    if (TERMINAL_STATUSES.has(current.status)) return { aborted: false, status: current.status, deployment: current };
    await sleep(Math.min(1000 * (attempt + 1), POLL_MS), undefined, { signal }).catch(() => undefined);
  }
  for (;;) {
    if (signal?.aborted) return { aborted: true };
    const current = await api.getDeployment(n);
    if (TERMINAL_STATUSES.has(current.status)) return { aborted: false, status: current.status, deployment: current };
    await sleep(POLL_MS, undefined, { signal }).catch(() => undefined);
  }
}

/** How many log lines a failure shows (human) and carries (JSON `log_tail`). */
export const FAILURE_TAIL = 50;

/** Local facts that sharpen the diagnosis: the exposed service and the migration sources. */
export type FailureHints = Pick<FailureInput, 'service' | 'migrations' | 'migrationsDir' | 'build'>;

/**
 * Error for a deployment that ended in `failed` (exit 8). Carries the failed step, a classified
 * cause with its fix (shared/src/diagnose.ts), and the last log lines.
 */
export function deployFailedError(d: Deployment, hints: FailureHints = {}): MicrocloudError {
  const step = d.error?.step ?? d.steps?.find((s) => s.status === 'failed')?.name ?? null;
  const own = d.error?.log_tail ?? [];
  const wide = d.log_tail ?? [];
  const tail = (wide.length >= own.length ? wide : own).slice(-FAILURE_TAIL);
  const message = d.error?.message ?? `deployment #${d.number} failed${step ? ` at step ${step}` : ''}`;
  const diagnosis = classifyFailure({ ...hints, step, message, log_tail: [...new Set([...own, ...wide])], deployment: d.number });
  return new MicrocloudError('deploy_failed', `deployment #${d.number} failed${step ? ` at ${step}` : ''}: ${diagnosis.summary}`, diagnosis.fix, {
    deployment: d.number,
    step,
    cause: diagnosis.cause,
    fix: diagnosis.fix,
    ...(diagnosis.file ? { file: diagnosis.file } : {}),
    ...(diagnosis.line !== undefined ? { line: diagnosis.line } : {}),
    evidence: diagnosis.evidence,
    error: message,
    log_tail: tail,
  });
}

/** Abort signal that fires on the first SIGINT; the second SIGINT is left to Node's default (exit). */
export function abortOnSigint(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  return { signal: controller.signal, dispose: () => process.off('SIGINT', onSigint) };
}
