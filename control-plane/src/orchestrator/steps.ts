/** Steps shared by the deployment kinds: database, spec, migrate; and the step detail lines for services. */
import type { Manifest } from '@microcloud/shared';
import type { MigrationFile } from '../db.js';
import { now } from '../db.js';
import { ensureUserMirror } from '../enduser/mirror.js';
import { fail } from '../errors.js';
import { buildSpec, classifyMigrations, type AppliedMigration, type Spec } from '../spec.js';
import type { SupervisorStatus } from '../supervisor.js';
import type { Job } from './job.js';

export function databaseStep(job: Job): Promise<{ url: string; host: string; branchId: string }> {
  const env = job.ctx.store.envById(job.envId)!;
  return job.step('database', () => job.ctx.resources.ensureDatabase(job.app.id, job.envId, (l) => job.log(l)), {
    detail: `database for ${env.name}`,
    done: () => `database for ${env.name} ready`,
  });
}

export function migrateStep(job: Job, url: string, files: MigrationFile[]): Promise<string> {
  return job.step('migrate', () => migrate(job, url, files), { status: 'migrating', detail: files.length ? `${files.length} migration file(s)` : 'no migration files', done: (d) => d });
}

export function writeSpec(job: Job, manifest: Manifest, db: { host: string; branchId: string } | null, migrations: { file: string; sha256: string }[]): Spec {
  const { store, resources } = job.ctx;
  const env = store.envById(job.envId)!;
  const prev = store.spec(env.id);
  const version = (prev?.version ?? 0) + 1;
  const applied: AppliedMigration[] = [];
  if (manifest.database) {
    const before = new Map((prev?.database?.applied ?? []).map((a) => [a.file, a]));
    for (const m of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
      applied.push(before.get(m.file) ?? { file: m.file, sha256: m.sha256, deployment: job.dep.number });
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
      box_id: env.box_id,
      box_url: env.box_url,
      db_host: db?.host ?? null,
      db_branch: db?.branchId ?? null,
      app_url: resources.appUrl(job.app.name, env.name),
    },
  });
  store.insertSpec(env.id, spec);
  store.updateDeployment(env.id, job.dep.number, { spec_version: version });
  return spec;
}

/** Runs pending migrations; returns the step detail, e.g. "0002_deals.sql (restore point created)". */
async function migrate(job: Job, url: string, files: MigrationFile[]): Promise<string> {
  const { appdb, store } = job.ctx;
  if (job.manifest().auth) {
    // Before the app's own migrations, so their RLS policies can call boxlite.current_user_id().
    await ensureUserMirror(job.ctx, url);
    job.log('sign-in: boxlite.users and boxlite.current_user_id() ready');
  }
  // The role SQL reads run as. Reads also create it lazily, so a failure here never fails a deploy.
  try {
    await appdb.ensureReader(url);
  } catch (err) {
    job.log(`warning: could not prepare the read-only database role yet: ${(err as Error).message}`);
  }
  if (!files.length) {
    job.log('no migration files');
    return 'no migration files';
  }
  const applied = await appdb.listApplied(url);
  const { pending, changed } = classifyMigrations(files, applied);
  if (changed.length) {
    throw fail('invalid_manifest', `applied migration(s) changed: ${changed.join(', ')}`, 'never edit an applied migration; restore the file and add a new NNNN_*.sql instead');
  }
  if (!pending.length) {
    job.log('database schema is up to date');
    return 'schema up to date';
  }
  store.updateDeployment(job.envId, job.dep.number, { restore_point: now() });
  const byName = new Map(files.map((f) => [f.file, f]));
  for (const file of pending) {
    job.log(`applying migration ${file}`);
    await appdb.applyMigration(url, byName.get(file)!, job.dep.number);
  }
  job.log(`applied ${pending.length} migration(s)`);
  return `${pending.join(', ')} (restore point created)`;
}

export function serviceNames(m: Pick<Manifest, 'services'>): string {
  return m.services.map((s) => s.name).join(', ') || 'no services';
}

/** "web :3000 healthy · worker running · 1 schedule" from the supervisor's live report. */
export function serviceSummary(s: SupervisorStatus, m: Pick<Manifest, 'services' | 'schedules'>): string {
  const parts = (s.services ?? []).map((sv) => {
    if (sv.port) return `${sv.name} :${sv.port} ${sv.health && sv.health !== 'none' ? sv.health : sv.state}`;
    return `${sv.name} ${sv.state}`;
  });
  if (!parts.length) parts.push(serviceNames(m));
  if (m.schedules.length) parts.push(`${m.schedules.length} schedule${m.schedules.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
