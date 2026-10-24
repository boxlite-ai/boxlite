// Live check of the Neon calls and the app-DB guard against real Neon (creates and deletes a
// throwaway project). Run: npx tsx scripts/neon-smoke.ts   (needs NEON_API_KEY, NEON_ORG_ID)
import { createHash } from 'node:crypto';
import { PgAppDatabase } from '../src/appdb.js';
import { loadDotEnvLocal } from '../src/config.js';
import { HttpNeonClient, withSslmode } from '../src/neon.js';

loadDotEnvLocal();
const neon = new HttpNeonClient(process.env.NEON_API_KEY ?? '', process.env.NEON_ORG_ID ?? '');
const db = new PgAppDatabase();
const step = (s: string) => console.log(`- ${s}`);
const sql = 'CREATE TABLE deals (id serial PRIMARY KEY, title text NOT NULL); INSERT INTO deals (title) VALUES (\'first\');';
const sha = createHash('sha256').update(sql).digest('hex');

const p = await neon.createProject(`mc-smoke-${Date.now().toString(36)}`);
step(`project ${p.projectId}, main branch ${p.mainBranchId}, host ${p.host}`);
try {
  const url = withSslmode(p.connectionUri);
  await db.applyMigration(url, { file: '0001_init.sql', sha256: sha, sql }, 1);
  step(`applied: ${JSON.stringify((await db.listApplied(url)).map((a) => a.file))}`);

  const ro = await db.query(url, ['SELECT title FROM deals'], { write: false });
  step(`read-only select → ${JSON.stringify(ro.rows)}`);
  try {
    await db.query(url, ["INSERT INTO deals (title) VALUES ('nope')"], { write: false });
    throw new Error('read-only transaction accepted a write');
  } catch (err) {
    step(`read-only insert refused: ${(err as Error).message}`);
  }
  try {
    await db.query(url, ['SELECT 1; COMMIT'], { write: false });
    throw new Error('extended protocol accepted two commands');
  } catch (err) {
    step(`two commands in one message refused: ${(err as Error).message}`);
  }

  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 2000));
  await db.query(url, ["INSERT INTO deals (title) VALUES ('second')"], { write: true });
  step(`after write: ${JSON.stringify((await db.query(url, ['SELECT count(*) FROM deals'], { write: false })).rows)}`);

  const b = await neon.createBranch(p.projectId, 'dev', p.mainBranchId, 'schema-only');
  const devUrl = withSslmode(await neon.connectionUri(p.projectId, b.branchId));
  step(`schema-only branch ${b.branchId}: rows ${JSON.stringify((await db.query(devUrl, ['SELECT count(*) FROM deals'], { write: false })).rows)}`);

  await neon.restoreBranch(p.projectId, p.mainBranchId, before, `main-before-restore-${Date.now()}`);
  // The compute restarts after a restore; give it a moment.
  let rows: unknown[][] = [];
  for (let i = 0; i < 10; i++) {
    try {
      rows = (await db.query(url, ['SELECT count(*) FROM deals'], { write: false })).rows;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  step(`restored main to ${before}: rows ${JSON.stringify(rows)} (expected 1)`);
  step(`branch size: ${(await neon.getBranch(p.projectId, p.mainBranchId)).logicalSizeBytes}`);
} finally {
  await neon.deleteProject(p.projectId);
  step(`deleted ${p.projectId}`);
}
