import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { newBoxToken, sha256hex } from '../src/auth.js';
import { migrateLegacyBlobs } from '../src/blobs.js';
import { now } from '../src/db.js';
import { createApp, harness, sha, type Harness } from './helpers.js';

let h: Harness;
let keyA: string;
let keyB: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  keyA = await createApp(h, 'crm');
  keyB = await createApp(h, 'evil');
});
after(() => h.close());

const SECRET = 'app A private config: password=hunter2\n';
const manifestOf = (files: Record<string, string>) => Object.entries(files).map(([path, c]) => ({ path, size: Buffer.byteLength(c), mode: 0o644, sha256: sha(c) }));

async function startUpload(app: string, key: string, files: Record<string, string>) {
  const res = await h.request(`/v1/apps/${app}/uploads`, { method: 'POST', key, json: { manifest: manifestOf(files) } });
  assert.equal(res.status, 200);
  return (await res.json()) as { upload_id: string; missing: string[] };
}

async function uploadAll(app: string, key: string, files: Record<string, string>): Promise<string> {
  const up = await startUpload(app, key, files);
  for (const content of Object.values(files)) {
    if (!up.missing.includes(sha(content))) continue;
    const put = await h.request(`/v1/apps/${app}/uploads/${up.upload_id}/files/${sha(content)}`, { method: 'PUT', key, body: content });
    assert.equal(put.status, 200);
  }
  const done = await h.request(`/v1/apps/${app}/uploads/${up.upload_id}/complete`, { method: 'POST', key });
  assert.equal(done.status, 200);
  return ((await done.json()) as { snapshot_id: string }).snapshot_id;
}

const appId = (name: string) => h.ctx.store.appByName(name)!.id;

function boxToken(app: string, env = 'main'): string {
  const token = newBoxToken();
  h.ctx.store.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), h.ctx.store.envByName(appId(app), env)!.id, now());
  return token;
}

function recordDeployment(app: string, env: string, snapshotId: string): void {
  const e = h.ctx.store.envByName(appId(app), env)!;
  h.ctx.store.insertDeployment(
    {
      kind: 'deploy', status: 'failed', message: null, by: 'test', created_at: now(), started_at: null, finished_at: now(), spec_version: null, base_version: 0,
      snapshot_id: snapshotId, steps: [], changes: [], error: null, request: { kind: 'deploy' }, idempotency_key: null, release: null, box_id: null, built: false,
      restore_point: null, live_at: null,
    },
    e.id,
  );
}

test('blobs are stored per App: DATA_DIR/blobs/<app_id>/<sha>', async () => {
  await uploadAll('crm', keyA, { 'config.txt': SECRET });
  assert.ok(existsSync(join(h.dir, 'blobs', appId('crm'), sha(SECRET))));
  assert.ok(!existsSync(join(h.dir, 'blobs', sha(SECRET))));
  assert.equal(h.ctx.blobs.has(appId('crm'), sha(SECRET)), true);
  assert.equal(h.ctx.blobs.has(appId('evil'), sha(SECRET)), false);
});

test('missing[] is per App: another App cannot learn that a hash exists', async () => {
  await uploadAll('crm', keyA, { 'config.txt': SECRET });
  const again = await startUpload('crm', keyA, { 'config.txt': SECRET });
  assert.deepEqual(again.missing, [], 'own content dedupes');
  const probe = await startUpload('evil', keyB, { 'stolen.txt': SECRET });
  assert.deepEqual(probe.missing, [sha(SECRET)], 'another App always has to send the bytes');
});

test("app B cannot complete a snapshot that references app A's blob without uploading it", async () => {
  await uploadAll('crm', keyA, { 'config.txt': SECRET });
  const up = await startUpload('evil', keyB, { 'stolen.txt': SECRET });
  const done = await h.request(`/v1/apps/evil/uploads/${up.upload_id}/complete`, { method: 'POST', key: keyB });
  assert.equal(done.status, 400);
  const err = ((await done.json()) as any).error;
  assert.equal(err.code, 'upload_incomplete');
  assert.deepEqual(err.missing, [sha(SECRET)]);
});

test("app B cannot deploy or fetch app A's snapshot by id", async () => {
  const snapA = await uploadAll('crm', keyA, { 'config.txt': SECRET });
  const dep = await h.request('/v1/apps/evil/envs/main/deployments', { method: 'POST', key: keyB, json: { kind: 'deploy', snapshot_id: snapA, manifest: {}, base_version: 0, migrations: [] } });
  assert.equal(dep.status, 404);
  recordDeployment('crm', 'main', snapA);
  const viaBox = await h.request(`/sv/v1/snapshots/${snapA}`, { key: boxToken('evil') });
  assert.equal(viaBox.status, 404);
});

test("a box token reads only its own env's snapshots", async () => {
  const snap = await uploadAll('crm', keyA, { 'config.txt': SECRET });
  await h.request('/v1/apps/crm/envs', { method: 'POST', key: keyA, json: { name: 'dev' } });
  recordDeployment('crm', 'main', snap);
  const main = await h.request(`/sv/v1/snapshots/${snap}`, { key: boxToken('crm', 'main') });
  assert.equal(main.status, 200);
  assert.equal(main.headers.get('content-type'), 'application/gzip');
  await main.arrayBuffer();
  const dev = await h.request(`/sv/v1/snapshots/${snap}`, { key: boxToken('crm', 'dev') });
  assert.equal(dev.status, 404, 'same App, other env: no deployment of dev uses this snapshot');
});

test('two Apps uploading identical content each keep their own copy', async () => {
  await uploadAll('crm', keyA, { 'a.txt': 'same' });
  await uploadAll('evil', keyB, { 'b.txt': 'same' });
  assert.equal(readFileSync(h.ctx.blobs.path(appId('crm'), sha('same')), 'utf8'), 'same');
  assert.equal(readFileSync(h.ctx.blobs.path(appId('evil'), sha('same')), 'utf8'), 'same');
});

test('start-up migration copies referenced legacy blobs into each App, idempotently', async () => {
  const legacyDir = join(h.dir, 'blobs');
  mkdirSync(legacyDir, { recursive: true });
  // buildCtx already ran the (empty) migration for this fresh DATA_DIR; pretend it is an old one.
  rmSync(join(legacyDir, '.per-app-v1'));
  writeFileSync(join(legacyDir, sha(SECRET)), SECRET);
  writeFileSync(join(legacyDir, sha('shared')), 'shared');
  const files = (contents: string[]) => JSON.stringify(contents.map((c, i) => ({ path: `f${i}`, size: c.length, mode: 0o644, sha256: sha(c) })));
  h.ctx.store.run('INSERT INTO snapshots (app_id, id, manifest, files, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)', appId('crm'), 'snap_a', files([SECRET, 'shared']), 2, 1, now());
  h.ctx.store.run('INSERT INTO uploads (id, app_id, manifest, created_at) VALUES (?, ?, ?, ?)', 'upl_b', appId('evil'), files(['shared']), now());
  migrateLegacyBlobs(h.ctx);
  assert.equal(h.ctx.blobs.has(appId('crm'), sha(SECRET)), true);
  assert.equal(h.ctx.blobs.has(appId('crm'), sha('shared')), true);
  assert.equal(h.ctx.blobs.has(appId('evil'), sha('shared')), true);
  assert.equal(h.ctx.blobs.has(appId('evil'), sha(SECRET)), false, 'only blobs an App references are copied to it');
  // Second run is a no-op and keeps what is there.
  migrateLegacyBlobs(h.ctx);
  assert.equal(readFileSync(h.ctx.blobs.path(appId('crm'), sha(SECRET)), 'utf8'), SECRET);
});

test('blob paths reject traversal in the app id or hash', () => {
  assert.throws(() => h.ctx.blobs.path('../x', sha('a')));
  assert.throws(() => h.ctx.blobs.path(appId('crm'), '../../cp.sqlite'));
  assert.equal(h.ctx.blobs.has('..', sha('a')), false);
});
