/** Deployments as the console's releases: ids, summaries, rollback possibility, the running step. */
import type { AppRow, Deployment, EnvRow } from './db.js';
import { ACTIVE_STATUSES } from './db.js';
import type { Ctx } from './ctx.js';
import { actorLabel } from './console-activity.js';
import { changeText, failureView, runningStepStartedAt } from './console-deployment.js';
import type { LastDeployView, ReleaseView } from './console-view-types.js';

export const releaseId = (n: number) => `#${n}`;

export function lastDeploy(d: Deployment | undefined): LastDeployView | null {
  return d ? { releaseId: releaseId(d.number), at: d.created_at, by: actorLabel(d.by) } : null;
}

/** The agent's message when it gave one; otherwise what changed, from the CP's own diff. */
function summaryOf(d: Deployment): string {
  if (d.message) return d.message;
  const paths = d.changes.map((c) => `${c.kind === 'online_only' ? '' : c.kind}${c.path}`);
  if (paths.length) return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` (+${paths.length - 3} more)` : '');
  return d.kind === 'deploy' ? 'Deploy' : d.kind === 'apply' ? 'Configuration change' : 'Rollback';
}

export function releaseViews(ctx: Pick<Ctx, 'store' | 'orchestrator'>, app: AppRow, env: EnvRow, limit = 50): ReleaseView[] {
  return ctx.store.deployments(env.id, limit).map((d) => {
    const snap = d.snapshot_id ? ctx.store.snapshot(app.id, d.snapshot_id) : undefined;
    const build = d.steps.find((s) => s.name === 'build' && s.status === 'done');
    const current = env.live_deployment === d.number;
    // A rollback restores the target's code and configuration, so an older deployment of the live release still counts.
    const problem = current ? 'this deployment is live' : ctx.orchestrator.rollbackProblem(env, d.number);
    return {
      id: releaseId(d.number),
      number: d.number,
      summary: summaryOf(d),
      createdAt: d.created_at,
      finishedAt: d.finished_at,
      by: actorLabel(d.by),
      status: d.status,
      current,
      ...(d.error ? { error: `${d.error.step}: ${d.error.message}` } : {}),
      steps: d.steps,
      changes: d.changes.map(changeText),
      files: snap?.files ?? null,
      bytes: snap?.bytes ?? null,
      buildSeconds: build?.ms !== undefined ? Math.round(build.ms / 100) / 10 : null,
      hasSource: !!snap,
      rollback: problem ? { possible: false, reason: problem } : { possible: true },
      restorePoint: d.restore_point,
      startedAt: d.started_at,
      running: ACTIVE_STATUSES.includes(d.status) ? runningOf(ctx, env, d) : null,
      cause: failureView(ctx, app, env, d)?.diagnosis.summary ?? null,
    };
  });
}

export function runningOf(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment): ReleaseView['running'] {
  const step = d.steps.find((s) => s.status === 'running');
  if (!step) return null;
  return { name: step.name, ...(step.detail ? { detail: step.detail } : {}), since: runningStepStartedAt(ctx, env, d) };
}
