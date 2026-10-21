import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { Store } from '../src/db.js';
import { controlHeaders, forwardHeaders } from '../src/supervisor.js';
import { BOX_CMD } from '../src/platform.js';
import { TOML, createApp, harness, upload, type Harness } from './helpers.js';

// Security review F3 (split secrets, CP side), the supervisor protocol check, and F10 (volumes by id).

let h: Harness;
let key: string;
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
});
after(() => h.close());

const env = (name = 'main') => h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, name)!;
const files = { 'boxlite.toml': TOML, 'package.json': '{}', 'package-lock.json': '{}', 'server.js': '' };

async function deploy(toml = TOML, envName = 'main'): Promise<Record<string, any>> {
  const m = parseManifest(toml, envName);
  assert.deepEqual(m.errors, []);
  const snapshot = await upload(h, key, { ...files, 'boxlite.toml': toml });
  const res = await h.request(`/v1/apps/crm/envs/${envName}/deployments`, { method: 'POST', key, json: { kind: 'deploy', snapshot_id: snapshot, manifest: m.manifest, base_version: 0, force: true, migrations: [] } });
  assert.equal(res.status, 202, await res.clone().text());
  const d = (await res.json()) as { number: number };
  await h.ctx.orchestrator.idle(env(envName).id);
  return (await (await h.request(`/v1/apps/crm/envs/${envName}/deployments/${d.number}`, { key })).json()) as Record<string, any>;
}

// ---- F3 ------------------------------------------------------------------------------------

test('every env has a control secret distinct from its forwarding secret', async () => {
  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  for (const e of [env('main'), env('dev')]) {
    assert.match(e.control_secret, /^[0-9a-f]{48}$/);
    assert.notEqual(e.control_secret, e.forward_secret);
  }
  assert.notEqual(env('main').control_secret, env('dev').control_secret);
});

test('the migration gives envs created before it a control secret', () => {
  const path = join(h.dir, 'old.sqlite');
  const s = new Store(path);
  s.run("INSERT INTO apps (id, name, created_at) VALUES ('app_1', 'old', 'now')");
  s.run("INSERT INTO envs (id, app_id, name, created_at, forward_secret) VALUES ('env_1', 'app_1', 'main', 'now', 'fwd')");
  s.close();
  // Roll the file back to the schema before migration 5.
  const raw = new DatabaseSync(path);
  raw.exec(
    'DROP TRIGGER envs_control_secret; DROP TABLE env_volumes; ALTER TABLE envs DROP COLUMN control_secret; ' +
      // and what migration 7 changed
      'ALTER TABLE envs RENAME COLUMN forward_secret TO gateway_secret; ALTER TABLE apps ADD COLUMN neon_host TEXT; DROP TABLE console_access; PRAGMA user_version = 4;',
  );
  raw.close();
  const migrated = new Store(path);
  const row = migrated.envById('env_1')!;
  migrated.close();
  assert.match(row.control_secret, /^[0-9a-f]{48}$/);
  assert.equal(row.forward_secret, 'fwd');
});

test('the spec hands the supervisor both secrets; control calls carry only the control secret', async () => {
  let seen: Record<string, any> | undefined;
  const orig = h.supervisor.deploy.bind(h.supervisor);
  h.supervisor.deploy = async (u, s, n) => {
    const box = [...h.boxlite.boxes.values()][0]!;
    seen = (await (await h.request('/sv/v1/spec', { headers: { authorization: `Bearer ${box.req.env.BOXLITE_BOX_TOKEN}` } })).json()) as Record<string, any>;
    return orig(u, s, n);
  };
  const d = await deploy();
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  const e = env();
  assert.equal(seen?.forward_secret, e.forward_secret);
  assert.equal(seen?.control_secret, e.control_secret);
  // gateway_secret was the protocol-1 name of the forwarding secret; no supervisor reads it any more.
  assert.equal('gateway_secret' in (seen ?? {}), false);
  assert.ok(h.supervisor.secrets.length >= 2);
  assert.ok(h.supervisor.secrets.every((s) => s === e.control_secret), `control calls used ${JSON.stringify(h.supervisor.secrets)}`);
});

test('header helpers: forwarding and control are separate names and values', () => {
  const e = env();
  assert.deepEqual(forwardHeaders(e), { 'x-boxlite-gateway': e.forward_secret });
  assert.deepEqual(controlHeaders(e), { 'x-boxlite-control': e.control_secret });
});

test('proxied end-user traffic carries the forwarding secret, never the control secret', async () => {
  const got: IncomingHttpHeaders[] = [];
  const upstream: Server = createServer((req, res) => {
    got.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  try {
    const box = await h.boxlite.createBox({ name: 'app-crm-main' } as never);
    h.ctx.store.updateEnv(env().id, { box_id: box.id, box_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, live_deployment: 1, access_override: 'public' });
    const res = await h.appRequest('/anything', { headers: { 'x-boxlite-control': 'forged' } });
    assert.equal(res.status, 200, await res.text());
    assert.equal(got.length, 1);
    assert.equal(got[0]!['x-boxlite-gateway'], env().forward_secret);
    assert.notEqual(got[0]!['x-boxlite-control'], env().control_secret);
  } finally {
    upstream.close();
  }
});

test('the Box cmd runs the supervisor as root through the launcher and never as boxlite', () => {
  const [sh, flag, boot, name, root] = BOX_CMD;
  assert.deepEqual([sh, flag, name], ['sh', '-c', 'microcloud-boot']);
  assert.match(boot!, /exec sudo -n "\$L"/);
  assert.match(boot!, /exec sudo -n -E sh -c "\$1"/);
  assert.match(root!, /\/home\/boxlite\/\.microcloud-root/);
  assert.match(root!, /\[ -x "\$R\/sv" \] && break/, 'keeps the cached binary when the CP is unreachable');
  assert.ok(!BOX_CMD.join(' ').includes("'"), 'scripts are read verbatim by the supervisor e2e test');
});

// ---- supervisor protocol ---------------------------------------------------------------------

test('a supervisor reporting an older wire protocol fails the deploy clearly, and the Box is not restarted', async () => {
  const first = await deploy();
  assert.equal(first.status, 'live');
  h.supervisor.version = 1;
  h.boxlite.calls.length = 0;
  const d = await deploy();
  assert.equal(d.status, 'failed');
  assert.match(d.error.message, /runs supervisor protocol 1; this control plane needs 2/);
  assert.deepEqual(h.boxlite.calls.filter((c) => c.startsWith('stop') || c.startsWith('start')), []);
});

// ---- F10: volumes by recorded id -------------------------------------------------------------

const VOL = `${TOML}\n[[volume]]\nname = "uploads"\nmount = "/data/uploads"\n`;

test('env deletion removes exactly the volumes the CP created for it, by id', async () => {
  await h.request('/v1/apps/crm/envs', { method: 'POST', key, json: { name: 'dev' } });
  // Someone else's volumes in the shared org that a prefix match would have taken.
  await h.boxlite.createVolume('mc-crm-dev-other');
  await h.boxlite.createVolume('mc-crm-dev-uploads-backup');
  const d = await deploy(VOL, 'dev');
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  const mine = h.boxlite.volumes.find((v) => v.name === 'mc-crm-dev-uploads')!;
  assert.deepEqual(h.ctx.store.envVolumes(env('dev').id), [{ name: 'mc-crm-dev-uploads', volume_id: mine.id }]);
  const res = await h.request('/v1/apps/crm/envs/dev', { method: 'DELETE', key });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(h.boxlite.volumes.map((v) => v.name).sort(), ['mc-crm-dev-other', 'mc-crm-dev-uploads-backup']);
});

test('a same-named volume the CP did not create is neither mounted nor deleted', async () => {
  await h.boxlite.createVolume('mc-crm-main-uploads');
  const d = await deploy(VOL);
  assert.equal(d.status, 'failed');
  assert.match(d.error.message, /was not created for this environment/);
  assert.deepEqual(h.ctx.store.envVolumes(env().id), []);
  await h.ctx.resources.deleteVolumes(h.ctx.store.appByName('crm')!, env());
  assert.deepEqual(h.boxlite.volumes.map((v) => v.name), ['mc-crm-main-uploads']);
});

test('volumes of envs created before ids were recorded are adopted from the CP record on the next deploy', async () => {
  const legacy = await h.boxlite.createVolume('mc-crm-main-uploads');
  const box = await h.boxlite.createBox({ name: 'app-crm-main', env: {} } as never);
  // What a pre-F10 CP left behind: the mount recorded by name in box_volumes, no id.
  h.ctx.store.updateEnv(env().id, { box_id: box.id, box_image: 'node', box_size: 'small', box_volumes: 'uploads:/data/uploads', box_url: 'https://8080-fake.proxy.test' });
  await h.ctx.resources.deleteVolumes(h.ctx.store.appByName('crm')!, env());
  assert.equal(h.boxlite.volumes.length, 1, 'not recorded by id: left in place');
  h.boxlite.boxes.delete(box.id); // force a new Box so volumes are resolved again
  const d = await deploy(VOL);
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.deepEqual(h.ctx.store.envVolumes(env().id), [{ name: 'mc-crm-main-uploads', volume_id: legacy.id }]);
  await h.ctx.resources.deleteVolumes(h.ctx.store.appByName('crm')!, env());
  assert.deepEqual(h.boxlite.volumes, []);
});
