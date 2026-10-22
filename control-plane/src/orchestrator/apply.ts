/** Deployment kind `apply`: a configuration-only change, restarting the live release with the new spec (no build). */
import type { Job } from './job.js';
import { databaseStep, migrateStep, serviceSummary, writeSpec } from './steps.js';
import type { SupervisorLink } from './supervisor-link.js';

/**
 * apply: config-only change (database, variables, access, …) without a new build.
 * On a live env the services are restarted by "rolling back" to the release that is already
 * current: the supervisor re-reads the spec (with the new env) and health-gates the restart, and
 * no new release dir is needed. That is the cheapest restart that still has a health gate.
 */
export async function runApply(job: Job, sv: SupervisorLink): Promise<number | null> {
  const { store, resources, supervisor } = job.ctx;
  const manifest = job.manifest();
  // An apply runs the live release's code with new configuration: record that code's snapshot, so
  // `deployments/{n}/source` (and `app clone`) works for an apply like for the deploy it restarts.
  const running = store.envById(job.envId)!.live_deployment;
  const code = running ? store.deployment(job.envId, running) : undefined;
  if (code?.snapshot_id && code.snapshot_id !== job.dep.snapshot_id) store.updateDeployment(job.envId, job.dep.number, { snapshot_id: code.snapshot_id });
  const migrations = job.dep.request.migrations ?? [];
  job.recordMigrations(migrations);

  const db = manifest.database ? await databaseStep(job) : null;
  const spec = writeSpec(job, manifest, db, migrations);
  job.log(`spec v${spec.version} written`);
  if (db) await migrateStep(job, db.url, migrations);
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
      job.setRelease(release, true);
      sv.forget(env.id, release);
      await sv.call('start', release, () => supervisor.rollback(env.box_url!, env.control_secret, release));
      return sv.waitLive(env.id, release);
    },
    { status: 'starting', detail: `restart release #${release} with the new configuration`, done: (s) => serviceSummary(s, manifest) },
  );
  return release;
}
