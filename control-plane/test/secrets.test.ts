import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { Store } from '../src/db.js';
import { controlHeaders, forwardHeaders, supervisorOutdated } from '../src/supervisor.js';
import { BOX_CMD } from '../src/platform.js';
import { TOML, createApp, harness, upload, type Harness } from './helpers.js';

// Security review F3 (split secrets, CP side), the protocol-1 rollout, and F10 (volumes by id).

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
    assert.notEqual(e.control_secret, e.gateway_secret);
  }
  assert.notEqual(env('main').control_secret, env('dev').control_secret);
});

test('the migration gives envs created before it a control secret', () => {
  const path = join(h.dir, 'old.sqlite');
  const s = new Store(path);
  s.run("INSERT INTO apps (id, name, created_at) VALUES ('app_1', 'old', 'now')");
  s.run("INSERT INTO envs (id, app_id, name, created_at, gateway_secret) VALUES ('env_1', 'app_1', 'main', 'now', 'fwd')");
  s.close();
  // Roll the file back to the schema before migration 5.
  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER envs_control_secret; DROP TABLE env_volumes; ALTER TABLE envs DROP COLUMN control_secret; PRAGMA user_version = 4;");
  raw.close();
  const migrated = new Store(path);
  const row = migrated.envById('env_1')!;
  migrated.close();
  assert.match(row.control_secret, /^[0-9a-f]{48}$/);
  assert.equal(row.gateway_secret, 'fwd');
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
  assert.equal(seen?.forward_secret, e.gateway_secret);
  assert.equal(seen?.control_secret, e.control_secret);
  // Protocol-1 supervisors read gateway_secret; it is the forwarding secret, never the control one.
  assert.equal(seen?.gateway_secret, e.gateway_secret);
  assert.ok(h.supervisor.secrets.length >= 2);
  assert.ok(h.supervisor.secrets.every((s) => s === e.control_secret), `control calls used ${JSON.stringify(h.supervisor.secrets)}`);
});

test('header helpers: forwarding and control are separate names and values', () => {
  const e = env();
  assert.deepEqual(forwardHeaders(e), { 'x-boxlite-gateway': e.gateway_secret });
  assert.deepEqual(controlHeaders(e), { 'x-boxlite-control': e.control_secret });
  assert.equal(supervisorOutdated({}), true, 'no version on the legacy probe = protocol 1');
  assert.equal(supervisorOutdated({}, true), false, 'a control-authenticated answer is at least protocol 2');
  assert.equal(supervisorOutdated({ version: 1 }, true), true);
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
    assert.equal(got[0]!['x-boxlite-gateway'], env().gateway_secret);
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

// ---- rollout: protocol-1 supervisors --------------------------------------------------------

test('a Box running a protocol-1 supervisor is restarted once, then the deploy goes on', async () => {
  const first = await deploy();
  assert.equal(first.status, 'live');
  const boxId = env().box_id!;
  h.supervisor.legacy = true;
  const start = h.boxlite.startBox.bind(h.boxlite);
  h.boxlite.startBox = async (id) => {
    await start(id);
    h.supervisor.legacy = false; // the old cmd fetched the current binary
  };
  h.boxlite.calls.length = 0;
  const d = await deploy();
  assert.equal(d.status, 'live', JSON.stringify(d.error));
  assert.deepEqual(h.boxlite.calls.filter((c) => c.startsWith('stop') || c.startsWith('start')), [`stop ${boxId}`, `start ${boxId}`]);
  const box = d.steps.find((s: { name: string }) => s.name === 'box');
  assert.ok(box, JSON.stringify(d.steps));
  const logs = (await (await h.request(`/v1/apps/crm/envs/main/deployments/${d.number}`, { key })).json()) as { log_tail?: string[] };
  assert.ok(JSON.stringify(logs).includes('supervisor protocol 1'), JSON.stringify(logs.log_tail));
});

test('a Box that stays on protocol 1 after the restart fails the deploy with a clear next step', async () => {
  await deploy();
  h.supervisor.legacy = true;
  const d = await deploy();
  assert.equal(d.status, 'failed');
  assert.match(d.error.message, /still runs supervisor protocol 1/);
});

test('at start the CP restarts running Boxes whose supervisor is protocol 1, and only those', async () => {
  await deploy();
  assert.deepEqual(await h.ctx.resources.upgradeOutdatedSupervisors(() => undefined), []);
  h.supervisor.legacy = true;
  assert.deepEqual(await h.ctx.resources.upgradeOutdatedSupervisors(() => undefined), [env().id]);
  assert.ok(h.boxlite.calls.includes(`stop ${env().box_id}`));
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
