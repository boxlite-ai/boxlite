import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { after, beforeEach, test } from 'node:test';
import { createApp, harness, sha, upload, type Harness } from './helpers.js';

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

test('a second upload of the same content has nothing missing and yields the same snapshot', async () => {
  const files = { 'a.txt': 'hello', 'src/b.txt': 'world' };
  const first = await upload(h, key, files);
  const res = await h.request('/v1/apps/crm/uploads', {
    method: 'POST',
    key,
    json: { manifest: Object.entries(files).map(([path, c]) => ({ path, size: c.length, mode: 0o644, sha256: sha(c) })) },
  });
  const up = (await res.json()) as { upload_id: string; missing: string[] };
  assert.deepEqual(up.missing, []);
  const done = (await (await h.request(`/v1/apps/crm/uploads/${up.upload_id}/complete`, { method: 'POST', key })).json()) as { snapshot_id: string; files: number; bytes: number };
  assert.equal(done.snapshot_id, first);
  assert.equal(done.files, 2);
  assert.equal(done.bytes, 10);
  assert.match(first, /^snap_[a-f0-9]{64}$/);
});

test('bytes that do not match the sha256 are rejected and not stored', async () => {
  const res = await h.request('/v1/apps/crm/uploads', { method: 'POST', key, json: { manifest: [{ path: 'a.txt', size: 5, mode: 0o644, sha256: sha('hello') }] } });
  const up = (await res.json()) as { upload_id: string; missing: string[] };
  const put = await h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha('hello')}`, { method: 'PUT', key, body: 'HELLO' });
  assert.equal(put.status, 400);
  assert.equal(((await put.json()) as any).error.code, 'checksum_mismatch');
  assert.equal(h.ctx.blobs.has(h.ctx.store.appByName('crm')!.id, sha('hello')), false);
  const done = await h.request(`/v1/apps/crm/uploads/${up.upload_id}/complete`, { method: 'POST', key });
  assert.equal(done.status, 400);
  const body = (await done.json()) as any;
  assert.equal(body.error.code, 'upload_incomplete');
  assert.deepEqual(body.error.missing, [sha('hello')]);
});

test('unsafe paths are refused', async () => {
  const res = await h.request('/v1/apps/crm/uploads', { method: 'POST', key, json: { manifest: [{ path: '../etc/passwd', size: 1, mode: 0o644, sha256: sha('x') }] } });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as any).error.code, 'invalid_manifest');
});

test('the snapshot streams back as tar.gz with the project at the top level', async () => {
  const id = await upload(h, key, { 'a.txt': 'hello', 'dir/b.txt': 'bee' });
  const snap = h.ctx.store.snapshot(h.ctx.store.appByName('crm')!.id, id)!;
  const { snapshotTarGz } = await import('../src/blobs.js');
  const chunks: Buffer[] = [];
  for await (const c of snapshotTarGz(h.ctx.blobs, h.ctx.store.appByName('crm')!.id, snap.manifest)) chunks.push(c as Buffer);
  const tar = gunzipSync(Buffer.concat(chunks)).toString('latin1');
  assert.ok(tar.includes('a.txt'));
  assert.ok(tar.includes('dir/'));
  assert.ok(tar.includes('dir/b.txt'));
  assert.ok(tar.includes('bee'));
});
