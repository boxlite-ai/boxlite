/** Deployment kind `deploy`: check → upload → database → box → build → migrate → start, from an uploaded snapshot. */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { checkLocal, type Manifest } from '@microcloud/shared';
import type { MigrationFile, SnapshotFile } from '../db.js';
import { fail } from '../errors.js';
import { MIGRATION_FILE_RE_CP } from '../migrations.js';
import { BOX_SIZES } from '../platform.js';
import { StepFailure, type Job } from './job.js';
import { databaseStep, migrateStep, serviceNames, serviceSummary, writeSpec } from './steps.js';
import type { SupervisorLink } from './supervisor-link.js';
import { checkFailedNext } from '../check-next.js';

/**
 * deploy: check → upload → database → box → build → migrate → start → live.
 *
 * Build-then-migrate-then-activate: the build runs in a fresh release dir while the old release
 * keeps serving, so a broken build never touches the database. Migrations run only once the new
 * code is known to build, and before it starts, so new code never sees the old schema. The old
 * code keeps serving during the migration, which is why migrations must stay backward compatible
 * for one release. A restore point is recorded right before the first pending migration.
 */
export async function runDeploy(job: Job, sv: SupervisorLink): Promise<number> {
  const { store, resources, supervisor, timing } = job.ctx;
  const manifest = job.manifest();
  const snapshot = store.snapshot(job.app.id, job.dep.snapshot_id ?? '');
  if (!snapshot) throw new StepFailure('check', `snapshot ${job.dep.snapshot_id} not found`);

  const migrations = await job.step('check', async () => {
    await checkSnapshot(job, manifest, snapshot.manifest);
    return migrationsFromSnapshot(job, manifest, snapshot.manifest);
  }, { detail: 'boxlite.toml and project files' });
  await job.step('upload', async () => undefined, { detail: `${snapshot.files} files, ${formatMb(snapshot.bytes)} (${snapshot.id.slice(0, 17)})` });

  const db = manifest.database ? await databaseStep(job) : null;

  const size = BOX_SIZES[manifest.runtime.size];
  const env = await job.step(
    'box',
    () => resources.ensureBox(job.app, job.envId, { image: manifest.runtime.image, size: manifest.runtime.size, volumes: manifest.volumes }, job.dep.number, (l) => job.log(l)),
    { detail: `${manifest.runtime.image}/${manifest.runtime.size}${size ? ` (${size.cpus} CPU, ${size.memory_mib / 1024} GB)` : ''}`, done: (e) => `${e.box_id} ${e.box_url ?? ''}`.trim() },
  );
  const spec = writeSpec(job, manifest, db, migrations);
  job.log(`spec v${spec.version} written`);

  const n = job.dep.number;
  await job.step(
    'build',
    async () => {
      store.updateDeployment(env.id, n, { box_id: env.box_id });
      store.updateEnv(env.id, { requested_deployment: n });
      job.setRelease(n);
      sv.forget(env.id, n);
      await sv.call('build', n, () => supervisor.deploy(env.box_url!, env.control_secret, n));
      const s = await sv.waitPhase(env.id, n, ['built', 'failed'], timing.buildMs, 'build');
      if (s.phase === 'failed') throw new StepFailure(s.step ?? 'build', s.error ?? 'build failed', s.log_tail);
      store.updateDeployment(env.id, n, { built: true });
    },
    { detail: manifest.runtime.build.length ? manifest.runtime.build.join(' && ') : 'no build steps' },
  );

  if (db) await migrateStep(job, db.url, migrations);
  job.checkCancelled();

  await job.step(
    'start',
    async () => {
      job.setRelease(n, true);
      sv.forget(env.id, n);
      await sv.call('start', n, () => supervisor.activate(env.box_url!, env.control_secret, n));
      return sv.waitLive(env.id, n);
    },
    { status: 'starting', detail: serviceNames(manifest), done: (s) => serviceSummary(s, manifest) },
  );
  return n;
}

/** The CP re-runs the shared local check against the uploaded files, so a hand-made upload cannot skip it. */
async function checkSnapshot(job: Job, manifest: Manifest, files: SnapshotFile[]): Promise<void> {
  const dir = mkdtempSync(join(job.ctx.config.dataDir, 'tmp', 'check-'));
  try {
    for (const f of files) {
      const dest = join(dir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        linkSync(job.ctx.blobs.path(job.app.id, f.sha256), dest);
      } catch {
        copyFileSync(job.ctx.blobs.path(job.app.id, f.sha256), dest);
      }
    }
    const result = await Promise.resolve(checkLocal(dir, manifest));
    for (const w of result.warnings) job.log(`warning: ${w.message}`);
    if (!result.ok || result.errors.length) {
      throw fail('invalid_manifest', `check failed: ${result.errors.map((e) => e.message).join('; ')}`, checkFailedNext(result.errors), { errors: result.errors });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** migrations/*.sql of the snapshot (top level of the migrations dir only, like the CLI). */
async function migrationsFromSnapshot(job: Job, manifest: Manifest, files: SnapshotFile[]): Promise<MigrationFile[]> {
  if (!manifest.database) return [];
  const dir = manifest.database.migrations.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const out: MigrationFile[] = [];
  for (const f of files) {
    const rel = dir ? (f.path.startsWith(dir + '/') ? f.path.slice(dir.length + 1) : null) : f.path;
    if (!rel || rel.includes('/') || !MIGRATION_FILE_RE_CP.test(rel)) continue;
    const sql = (await buffer(job.ctx.blobs.read(job.app.id, f.sha256))).toString('utf8');
    out.push({ file: rel, sha256: f.sha256, sql });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  job.recordMigrations(out);
  return out;
}

function formatMb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
