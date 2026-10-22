/** Deployment kind `rollback`: a copy of #N's spec, an optional database restore, and a switch to #N's release; plus the rollback checks. */
import type { EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import type { Spec } from '../spec.js';
import { StepFailure, type Job } from './job.js';
import { serviceSummary } from './steps.js';
import type { SupervisorLink } from './supervisor-link.js';

/** rollback to #N: N's spec as a new version, optional database restore, switch to N's release dir. */
export async function runRollback(job: Job, sv: SupervisorLink): Promise<number> {
  const { store, resources, supervisor, neon } = job.ctx;
  const to = job.dep.request.to!;
  const target = store.deployment(job.envId, to);
  if (!target?.release || !target.spec_version) throw new StepFailure('check', `deployment #${to} has no release to roll back to`);
  const targetSpec = store.spec(job.envId, target.spec_version)!;
  const release = target.release;

  if (job.dep.request.with_database) {
    const ts = restoreTimestampFor(job.ctx, job.envId, to);
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
      job.setRelease(release, true);
      sv.forget(env.id, release);
      await sv.call('start', release, () => supervisor.rollback(env.box_url!, env.control_secret, release));
      return sv.waitLive(env.id, release);
    },
    { status: 'starting', detail: `switch to release #${release}`, done: (s) => serviceSummary(s, targetSpec) },
  );
  return release;
}

// ---- read-only release queries ----------------------------------------------------

/**
 * The database state that matches #N is the one right before the first later deployment changed
 * the schema, so restore to the earliest restore point recorded after N (none → nothing to undo).
 */
export function restoreTimestampFor(ctx: Pick<Ctx, 'store'>, envId: string, to: number): string | null {
  const row = ctx.store.get<{ ts: string | null }>('SELECT MIN(restore_point) AS ts FROM deployments WHERE env_id = ? AND number > ? AND restore_point IS NOT NULL', envId, to);
  return row?.ts ?? null;
}

/** Releases still on the env's Box: the supervisor keeps the newest 3 built release dirs plus `current` (failed builds are removed). */
export function rollbackProblem(ctx: Pick<Ctx, 'store'>, env: EnvRow, to: number): string | null {
  const { store } = ctx;
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
