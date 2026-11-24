/** Deployment kind `apply`: a configuration-only change, restarting the live release with the new spec (no build). */
import type { Job } from './job'
import { PHASED_SUPERVISOR_PROTOCOL } from '../platform'
import { databaseStep, migrateStep, serviceSummary, writeSpec } from './steps'
import type { SupervisorLink } from './supervisor-link'

/**
 * apply: config-only change (database, variables, access, …) without a new build.
 * On a live env the services are restarted by "rolling back" to the release that is already
 * current: the supervisor re-reads the spec (with the new env) and health-gates the restart, and
 * no new release dir is needed. That is the cheapest restart that still has a health gate.
 */
export async function runApply(job: Job, sv: SupervisorLink): Promise<number | null> {
  const { store, resources, supervisor } = job.ctx
  const manifest = job.manifest()
  // An apply runs the live release's code with new configuration: record that code's snapshot, so
  // `deployments/{n}/source` (and `app clone`) works for an apply like for the deploy it restarts.
  const initial = (await store.envById(job.envId))!
  const running = initial.live_deployment
  const code = running ? await store.deployment(job.envId, running) : undefined
  const log = (line: string) => job.log(line)
  if (initial.active_box_id && code?.release)
    await resources.ensureRunning(initial.id, log, job.signal, PHASED_SUPERVISOR_PROTOCOL)
  if (code?.snapshot_id && code.snapshot_id !== job.dep.snapshot_id)
    await store.updateDeployment(job.envId, job.dep.number, { snapshot_id: code.snapshot_id })
  const migrations = job.dep.request.migrations ?? []
  await job.recordMigrations(migrations)

  const db = manifest.database ? await databaseStep(job) : null
  const spec = await writeSpec(job, manifest, db, migrations)
  await job.log(`spec v${spec.version} written`)
  if (db) await migrateStep(job, db.url, migrations)
  await job.checkCancelled()

  const env = (await store.envById(job.envId))!
  const live = env.live_deployment ? await store.deployment(env.id, env.live_deployment) : undefined
  if (!env.active_box_id || !live?.release) {
    await job.log('no running release yet; the next deploy starts services with this configuration')
    return null
  }
  if (env.box_image !== manifest.runtime.image || env.box_size !== manifest.runtime.size) {
    await job.log('runtime image/size changes take effect on the next deploy')
  }
  const release = live.release
  await job.step(
    'start',
    async () => {
      const box = await resources.ensureRunning(env.id, log, job.signal, PHASED_SUPERVISOR_PROTOCOL)
      const target = { operation: job.dep.number, spec_version: spec.version }
      await store.updateDeployment(env.id, target.operation, { release })
      await store.updateEnv(env.id, { requested_deployment: job.dep.number })
      job.setRelease(release, true)
      await sv.forget(env.id, target.operation)
      await sv.call(
        'start',
        release,
        async () => await supervisor.rollback(box.box_url!, box.control_secret, release, target),
        job.signal,
      )
      return await sv.waitLive(env.id, release, job.signal, target)
    },
    {
      status: 'starting',
      detail: `restart release #${release} with the new configuration`,
      done: (s) => serviceSummary(s, manifest),
    },
  )
  return release
}
