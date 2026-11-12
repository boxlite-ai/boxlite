/** Steps shared by the deployment kinds: database, spec, migrate; and the step detail lines for services. */
import type { Manifest } from '@boxlite-ai/cloud-app-shared'
import type { MigrationFile } from '../db'
import { now } from '../db'
import { ensureUserMirror } from '../enduser/mirror'
import { fail } from '../errors'
import { buildSpec, classifyMigrations, type AppliedMigration, type Spec } from '../spec'
import type { SupervisorStatus } from '../supervisor'
import type { Job } from './job'

export async function databaseStep(job: Job): Promise<{ url: string; host: string; branchId: string }> {
  const env = (await job.ctx.store.envById(job.envId))!
  return await job.step(
    'database',
    async () =>
      await job.ctx.resources.ensureDatabase(job.app.id, job.envId, async (l) => await job.log(l), job.signal),
    {
      detail: `database for ${env.name}`,
      done: () => `database for ${env.name} ready`,
    },
  )
}

export async function migrateStep(job: Job, url: string, files: MigrationFile[]): Promise<string> {
  return await job.step('migrate', async () => await migrate(job, url, files), {
    status: 'migrating',
    detail: files.length ? `${files.length} migration file(s)` : 'no migration files',
    done: (d) => d,
  })
}

export async function writeSpec(
  job: Job,
  manifest: Manifest,
  db: { host: string; branchId: string } | null,
  migrations: { file: string; sha256: string }[],
): Promise<Spec> {
  const { store, resources } = job.ctx
  const env = (await store.envById(job.envId))!
  const prev = await store.spec(env.id)
  const version = (prev?.version ?? 0) + 1
  const applied: AppliedMigration[] = []
  if (manifest.database) {
    const before = new Map((prev?.database?.applied ?? []).map((a) => [a.file, a]))
    for (const m of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
      applied.push(before.get(m.file) ?? { file: m.file, sha256: m.sha256, deployment: job.dep.number })
    }
  }
  const spec = buildSpec({
    manifest,
    version,
    deployment: job.dep.number,
    baseVersion: job.dep.base_version ?? prev?.version ?? 0,
    applied,
    accessOverride: env.access_override,
    assigned: {
      box_id: env.active_box_id,
      box_url: env.box_url,
      db_host: db?.host ?? null,
      db_branch: db?.branchId ?? null,
      app_url: await resources.appUrl(job.app.name, env.name),
    },
  })
  await store.insertSpec(env.id, spec)
  await store.updateDeployment(env.id, job.dep.number, { spec_version: version })
  return spec
}

/** Runs pending migrations; returns the step detail, e.g. "0002_deals.sql (restore point created)". */
async function migrate(job: Job, url: string, files: MigrationFile[]): Promise<string> {
  const { appdb, store } = job.ctx
  if (job.manifest().auth) {
    // Before the app's own migrations, so their RLS policies can call boxlite.current_user_id().
    job.signal?.throwIfAborted()
    await ensureUserMirror(job.ctx, url)
    await job.log('sign-in: boxlite.users and boxlite.current_user_id() ready')
  }
  // The role SQL reads run as. Reads also create it lazily, so a failure here never fails a deploy.
  try {
    job.signal?.throwIfAborted()
    await appdb.ensureReader(url)
  } catch (err) {
    await job.log(`warning: could not prepare the read-only database role yet: ${(err as Error).message}`)
  }
  if (!files.length) {
    await job.log('no migration files')
    return 'no migration files'
  }
  const applied = await appdb.listApplied(url)
  const { pending, changed } = classifyMigrations(files, applied)
  if (changed.length) {
    throw fail(
      'invalid_manifest',
      `applied migration(s) changed: ${changed.join(', ')}`,
      'never edit an applied migration; restore the file and add a new NNNN_*.sql instead',
    )
  }
  if (!pending.length) {
    await job.log('database schema is up to date')
    return 'schema up to date'
  }
  await store.updateDeployment(job.envId, job.dep.number, { restore_point: now() })
  const byName = new Map(files.map((f) => [f.file, f]))
  for (const file of pending) {
    await job.log(`applying migration ${file}`)
    job.signal?.throwIfAborted()
    await appdb.applyMigration(url, byName.get(file)!, job.dep.number)
  }
  await job.log(`applied ${pending.length} migration(s)`)
  return `${pending.join(', ')} (restore point created)`
}

export function serviceNames(m: Pick<Manifest, 'services'>): string {
  return m.services.map((s) => s.name).join(', ') || 'no services'
}

/** "web :3000 healthy · worker running · 1 schedule" from the supervisor's live report. */
export function serviceSummary(s: SupervisorStatus, m: Pick<Manifest, 'services' | 'schedules'>): string {
  const parts = (s.services ?? []).map((sv) => {
    if (sv.port) return `${sv.name} :${sv.port} ${sv.health && sv.health !== 'none' ? sv.health : sv.state}`
    return `${sv.name} ${sv.state}`
  })
  if (!parts.length) parts.push(serviceNames(m))
  if (m.schedules.length) parts.push(`${m.schedules.length} schedule${m.schedules.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
