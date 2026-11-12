/** Deployment kind `rollback`: a copy of #N's spec, an optional database restore, and a switch to #N's release; plus the rollback checks. */
import type { EnvRow } from '../db'
import type { Ctx } from '../ctx'
import type { Spec } from '../spec'
import { StepFailure, type Job } from './job'
import { serviceSummary } from './steps'
import type { SupervisorLink } from './supervisor-link'

/** rollback to #N: N's spec as a new version, optional database restore, switch to N's release dir. */
export async function runRollback(job: Job, sv: SupervisorLink): Promise<number> {
  const { store, resources, supervisor, neon } = job.ctx
  const to = job.dep.request.to!
  const target = await store.deployment(job.envId, to)
  if (!target?.release || !target.spec_version)
    throw new StepFailure('check', `deployment #${to} has no release to roll back to`)
  const targetSpec = (await store.spec(job.envId, target.spec_version))!
  const release = target.release

  if (job.dep.request.with_database) {
    const ts = await restoreTimestampFor(job.ctx, job.envId, to)
    await job.step(
      'database',
      async () => {
        if (!ts) {
          await job.log(`no migrations ran after #${to}; database left as is`)
          return
        }
        const app = (await store.appById(job.app.id))!
        const env = (await store.envById(job.envId))!
        if (!app.neon_project_id || !env.neon_branch_id) throw new Error('this environment has no database')
        await job.log(`restoring Neon branch ${env.neon_branch_id} to ${ts}`)
        job.signal?.throwIfAborted()
        await neon.restoreBranch(
          app.neon_project_id,
          env.neon_branch_id,
          ts,
          `${env.name}-before-rollback-${job.dep.number}`,
        )
      },
      { detail: ts ? `restore to ${ts}` : 'no schema change since #' + to },
    )
  }

  const env = (await store.envById(job.envId))!
  const version = (await store.latestSpecVersion(env.id)) + 1
  const spec: Spec = {
    ...targetSpec,
    version,
    deployment: job.dep.number,
    base_version: version - 1,
    assigned: {
      ...targetSpec.assigned,
      box_id: env.active_box_id,
      box_url: env.box_url,
      app_url: await resources.appUrl(job.app.name, env.name),
    },
  }
  await store.insertSpec(env.id, spec)
  await store.updateDeployment(env.id, job.dep.number, { spec_version: version, snapshot_id: target.snapshot_id })
  await job.log(`spec v${version} written (copy of v${target.spec_version} from #${to})`)
  await job.checkCancelled()

  await job.step(
    'start',
    async () => {
      await resources.ensureRunning(env.id, async (l) => await job.log(l), job.signal)
      await store.updateEnv(env.id, { requested_deployment: job.dep.number })
      job.setRelease(release, true)
      await sv.forget(env.id, release)
      await sv.call(
        'start',
        release,
        async () => await supervisor.rollback(env.box_url!, env.control_secret, release),
        job.signal,
      )
      return await sv.waitLive(env.id, release, job.signal)
    },
    { status: 'starting', detail: `switch to release #${release}`, done: (s) => serviceSummary(s, targetSpec) },
  )
  return release
}

// ---- read-only release queries ----------------------------------------------------

/**
 * The database state that matches #N is the one right before the first later deployment changed
 * the schema, so restore to the earliest restore point recorded after N (none → nothing to undo).
 */
export async function restoreTimestampFor(ctx: Pick<Ctx, 'store'>, envId: string, to: number): Promise<string | null> {
  const row = await ctx.store.get<{ ts: string | null }>(
    'SELECT MIN(restore_point) AS ts FROM deployments WHERE env_id = ? AND number > ? AND restore_point IS NOT NULL',
    envId,
    to,
  )
  return row?.ts ?? null
}

/** Releases still on the env's Box: the supervisor keeps the newest 3 built release dirs plus `current` (failed builds are removed). */
export async function rollbackProblem(ctx: Pick<Ctx, 'store'>, env: EnvRow, to: number): Promise<string | null> {
  const { store } = ctx
  const target = await store.deployment(env.id, to)
  if (!target) return `no deployment #${to}`
  if (!['live', 'superseded', 'rolled_back'].includes(target.status))
    return `deployment #${to} never went live (${target.status})`
  if (!target.release) return `deployment #${to} has no release (it ran before the first deploy)`
  if (!env.active_box_id || target.box_id !== env.active_box_id)
    return `deployment #${to} ran on a Box that has since been replaced`
  const live = env.live_deployment ? await store.deployment(env.id, env.live_deployment) : undefined
  const recent = (
    await store.deploymentsWhere(
      "env_id = ? AND kind = 'deploy' AND built = 1 AND box_id = ? ORDER BY number DESC LIMIT 3",
      env.id,
      env.active_box_id,
    )
  ).map((d) => d.number)
  if (target.release !== live?.release && !recent.includes(target.release))
    return `release #${target.release} has been pruned from the Box (only the newest 3 are kept)`
  return null
}
