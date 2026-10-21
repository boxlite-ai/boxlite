import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { BOX_CMD } from '../src/platform.js';
import { TOML, createApp, harness, sha, upload, type Harness } from './helpers.js';

let h: Harness;
let key: string;
const files = { 'boxlite.toml': TOML, 'package.json': '{"name":"crm"}', 'package-lock.json': '{}', 'server.js': 'console.log(1)' };
const manifest = () => parseManifest(TOML, 'main').manifest!;

beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

async function deploy(extra: Record<string, unknown> = {}) {
  const snapshot = await upload(h, key, files);
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifest(), base_version: 0, migrations: [], ...extra } });
  assert.equal(res.status, 202, await res.clone().text());
  const dep = (await res.json()) as { number: number; status: string };
  const env = h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
  await h.ctx.orchestrator.idle(env.id);
  const detail = await h.request(`/v1/apps/crm/envs/main/deployments/${dep.number}`, { key });
  return (await detail.json()) as Record<string, any>;
}

test('deploy happy path: box, build, start, live', async () => {
  const d = await deploy({ message: 'first' });
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.deepEqual(
    d.steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`),
    ['check:done', 'upload:done', 'box:done', 'build:done', 'start:done', 'live:done'],
  );
  assert.equal(d.steps.find((s: { name: string }) => s.name === 'build').detail, 'npm ci');
  assert.match(d.steps.find((s: { name: string }) => s.name === 'start').detail, /web :3000 healthy/);
  assert.equal(d.steps.find((s: { name: string }) => s.name === 'live').detail, 'https://10001-cp.test');
  assert.equal(d.spec_version, 1);
  assert.equal(d.release, 1);
  assert.deepEqual(h.supervisor.calls.filter((c) => c !== 'health'), ['deploy 1', 'activate 1']);

  const box = [...h.boxlite.boxes.values()][0]!;
  assert.equal(box.req.name, 'app-crm-main');
  assert.equal(box.req.image, 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0');
  assert.deepEqual([box.req.cpus, box.req.memory_mib, box.req.disk_size_gb], [1, 2048, 10]);
  assert.deepEqual(box.req.cmd, BOX_CMD);
  assert.equal(box.req.env.BOXLITE_CP_URL, 'https://cp.test');
  assert.match(box.req.env.BOXLITE_BOX_TOKEN!, /^bxt_/);
  assert.equal(box.req.env.SV_TRUST_USER_HEADERS, '1');

  // The supervisor wire sees the deployment it was told to run.
  const spec = await h.request('/sv/v1/spec', { headers: { authorization: `Bearer ${box.req.env.BOXLITE_BOX_TOKEN}` } });
  const body = (await spec.json()) as Record<string, any>;
  assert.equal(body.deployment, 1);
  assert.equal(body.spec.services[0].port, 3000);
  assert.equal(body.env.BOXLITE_APP_URL, 'https://10001-cp.test');
  assert.ok(body.snapshot.url.endsWith(`/sv/v1/snapshots/${d.snapshot_id}`));

  // A second deploy supersedes the first and reuses the Box.
  const d2 = await deploy({ base_version: 1 });
  assert.equal(d2.status, 'live');
  assert.equal(h.boxlite.boxes.size, 1);
  const first = await (await h.request('/v1/apps/crm/envs/main/deployments/1', { key })).json();
  assert.equal((first as { status: string }).status, 'superseded');
});

test('build failure: deployment fails at build, nothing goes live', async () => {
  h.supervisor.failBuild = true;
  const d = await deploy();
  assert.equal(d.status, 'failed');
  assert.equal(d.error.step, 'build');
  assert.match(d.error.message, /npm ci exited/);
  assert.deepEqual(d.error.log_tail, ['npm ERR! missing script']);
  assert.deepEqual(h.supervisor.calls.filter((c) => c !== 'health'), ['deploy 1']);
  const env = h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
  assert.equal(env.live_deployment, null);
  assert.equal(env.requested_deployment, null);
  // The failed attempt left a spec version behind, but the fix-and-redeploy must not look stale.
  h.supervisor.failBuild = false;
  const retry = await deploy({ base_version: 0 });
  assert.equal(retry.status, 'live');
});

test('stale base is rejected unless forced', async () => {
  await deploy();
  const snapshot = await upload(h, key, files);
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifest(), base_version: 0, migrations: [] } });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).error.code, 'stale_base');
});

test('idempotency key returns the same deployment', async () => {
  const snapshot = await upload(h, key, files);
  const init = { method: 'POST', key, headers: { 'idempotency-key': 'abc' }, json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifest(), base_version: 0, migrations: [] } };
  const a = (await (await h.request('/v1/apps/crm/envs/main/deployments', init)).json()) as { number: number };
  const b = (await (await h.request('/v1/apps/crm/envs/main/deployments', init)).json()) as { number: number };
  assert.equal(a.number, b.number);
  await h.ctx.orchestrator.idle(h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!.id);
});

test('apply with a database runs migrations and restarts onto the live release', async () => {
  await deploy();
  const toml = TOML + '\n[database]\nmigrations = "migrations/"\n';
  const sql = 'CREATE TABLE deals (id int);';
  const res = await h.request('/v1/apps/crm/envs/main/deployments', {
    method: 'POST',
    key,
    json: { kind: 'apply', manifest: parseManifest(toml, 'main').manifest, base_version: 1, migrations: [{ file: '0001_init.sql', sha256: sha(sql), sql }] },
  });
  assert.equal(res.status, 202, await res.clone().text());
  const env = h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
  await h.ctx.orchestrator.idle(env.id);
  const d = (await (await h.request('/v1/apps/crm/envs/main/deployments/2', { key })).json()) as Record<string, any>;
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.deepEqual(d.steps.map((s: { name: string }) => s.name), ['database', 'migrate', 'start', 'live']);
  assert.match(d.steps[1].detail, /0001_init.sql \(restore point created\)/);
  assert.ok(d.restore_point);
  assert.equal(d.release, 1);
  assert.deepEqual(h.supervisor.calls.filter((c) => c !== 'health'), ['deploy 1', 'activate 1', 'rollback 1']);
  assert.deepEqual(h.neon.calls, ['project mc-crm']);
  assert.deepEqual(h.appdb.applied.map((a) => a.file), ['0001_init.sql']);
  const spec = h.ctx.store.spec(env.id)!;
  assert.equal(spec.assigned.db_branch, 'br-main');
  assert.deepEqual(spec.database?.applied.map((a) => a.file), ['0001_init.sql']);
});

test('rollback switches to an older release and marks the replaced one rolled_back', async () => {
  await deploy();
  await deploy({ base_version: 1 });
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'rollback', to: 1 } });
  assert.equal(res.status, 202, await res.clone().text());
  const env = h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
  await h.ctx.orchestrator.idle(env.id);
  const d3 = (await (await h.request('/v1/apps/crm/envs/main/deployments/3', { key })).json()) as Record<string, any>;
  assert.equal(d3.status, 'live', JSON.stringify(d3.error));
  assert.equal(d3.message, 'Roll back to #1');
  assert.equal(d3.release, 1);
  assert.equal(h.supervisor.calls.at(-1), 'rollback 1');
  const d2 = (await (await h.request('/v1/apps/crm/envs/main/deployments/2', { key })).json()) as Record<string, any>;
  assert.equal(d2.status, 'rolled_back');
});

test('the App key only opens its own app', async () => {
  await createApp(h, 'other');
  const res = await h.request('/v1/apps/other', { key });
  assert.equal(res.status, 403);
  const me = await h.request('/v1/apps/me', { key });
  assert.equal(((await me.json()) as { name: string }).name, 'crm');
  const none = await h.request('/v1/apps/crm');
  assert.equal(none.status, 401);
});

test('supervisor wire: status with Go-style nulls and log batches are accepted', async () => {
  await deploy();
  const box = [...h.boxlite.boxes.values()][0]!;
  const auth = { authorization: `Bearer ${box.req.env.BOXLITE_BOX_TOKEN}` };
  const st = await h.request('/sv/v1/status', { method: 'POST', headers: auth, json: { deployment: 1, phase: 'live', services: null } });
  assert.equal(st.status, 200, await st.clone().text());
  const logs = await h.request('/sv/v1/logs', { method: 'POST', headers: auth, json: [{ ts: '2026-10-21T10:00:00Z', source: 'web', level: 'info', line: 'listening', deployment: 1 }] });
  assert.equal(logs.status, 200);
  const got = (await (await h.request('/v1/apps/crm/envs/main/logs?source=web', { key })).json()) as { line: string }[];
  assert.deepEqual(got.map((l) => l.line), ['listening']);
  const bad = await h.request('/sv/v1/spec', { headers: { authorization: 'Bearer bxt_wrong' } });
  assert.equal(bad.status, 401);
});

test('a busy supervisor (409 deploy_in_progress) is retried', async () => {
  h.supervisor.busy = 2;
  const d = await deploy();
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.deepEqual(h.supervisor.calls.filter((c) => c !== 'health'), ['deploy 1', 'deploy 1', 'deploy 1', 'activate 1']);
});

test('spec for a brand-new env names no deployment but carries the gateway secret; then the one being built', async () => {
  const snapshot = await upload(h, key, files);
  const app = h.ctx.store.appByName('crm')!;
  const env = h.ctx.store.envByName(app.id, 'main')!;
  let seen: Record<string, any> | undefined;
  const orig = h.supervisor.deploy.bind(h.supervisor);
  h.supervisor.deploy = async (u, s, n) => {
    const box = [...h.boxlite.boxes.values()][0]!;
    seen = (await (await h.request('/sv/v1/spec', { headers: { authorization: `Bearer ${box.req.env.BOXLITE_BOX_TOKEN}` } })).json()) as Record<string, any>;
    return orig(u, s, n);
  };
  // Before anything ran: valid response without a deployment.
  const tokenless = h.ctx.store.envById(env.id)!;
  assert.equal(tokenless.requested_deployment, null);
  await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: manifest(), base_version: 0, migrations: [] } });
  await h.ctx.orchestrator.idle(env.id);
  assert.equal(seen?.deployment, 1);
  assert.equal(seen?.spec.deployment, 1);
  assert.equal(seen?.forward_secret, env.forward_secret);
});

test('403 from a fresh gateway means "not ready yet" while waiting for the supervisor', async () => {
  h.supervisor.forbiddenHealth = 3;
  const d = await deploy();
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.equal(h.supervisor.calls.filter((c) => c === 'health').length, 4);
});
