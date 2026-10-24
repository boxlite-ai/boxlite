import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { deleteApp } from '../src/lifecycle.js';
import { verifyDomain } from '../src/services/domains.js';
import { createApp, harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.close());

const TARGET = 'domains.proxy.boxlite.test';
const TOKEN = 'resolver-token-0123456789';
const dns = (txt: Record<string, string[]>, cname: Record<string, string> = {}) => ({
  txt: async (name: string) => (txt[name] ?? []).map((v) => [v]),
  cname: async (name: string) => (cname[name] ? [cname[name]!] : []),
});

test('custom domains stay refused on a CP without the proxy resolver', async () => {
  h = harness();
  const key = await createApp(h);
  const res = await h.request('/v1/apps/crm/envs/main/domains', { method: 'POST', key, json: { host: 'shop.acme.com' } });
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_supported_yet');
  assert.equal((await h.request('/proxy/hosts?host=shop.acme.com', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401);
});

test('a domain is routed to the env only after its TXT proves ownership, and only to the proxy', async () => {
  h = harness({ customDomains: { target: TARGET, resolverToken: TOKEN } });
  const key = await createApp(h);
  const added = await h.request('/v1/apps/crm/envs/main/domains', { method: 'POST', key, json: { host: 'Shop.Acme.com.' } });
  assert.equal(added.status, 201, await added.clone().text());
  const d = (await added.json()) as { host: string; status: string; records: { type: string; name: string; value: string }[] };
  assert.equal(d.host, 'shop.acme.com');
  assert.equal(d.status, 'pending_dns');
  const txt = d.records.find((r) => r.type === 'TXT')!;
  assert.equal(txt.name, '_boxlite-challenge.shop.acme.com');
  assert.deepEqual(d.records.find((r) => r.type === 'CNAME'), { type: 'CNAME', name: 'shop.acme.com', value: TARGET });

  const ask = (host: string, token = TOKEN) => h.request(`/proxy/hosts?host=${host}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await ask('shop.acme.com')).status, 404, 'not routed before verification');

  const app = h.ctx.store.appByName('crm')!;
  const env = h.ctx.store.envByName(app.id, 'main')!;
  await assert.rejects(verifyDomain(h.ctx, app, env, 'shop.acme.com', 'test', dns({})), /has no TXT record/);
  const ok = await verifyDomain(h.ctx, app, env, 'shop.acme.com', 'test', dns({ [txt.name]: [txt.value] }, { 'shop.acme.com': `${TARGET}.` }));
  assert.equal(ok.status, 'active');
  assert.equal(ok.cname_ok, true);

  const routed = await ask('SHOP.acme.com:443');
  assert.equal(routed.status, 200);
  const target = (await routed.json()) as { box_id: string; port: number };
  assert.equal(target.port, h.ctx.origins.portOf(env.id));
  assert.ok(target.box_id.length > 0);
  assert.equal((await ask('shop.acme.com', 'wrong')).status, 401, 'only the proxy may ask');

  // Another App cannot claim it; a deleted App stops being routed.
  const other = await createApp(h, 'other');
  assert.equal((await h.request('/v1/apps/other/envs/main/domains', { method: 'POST', key: other, json: { host: 'shop.acme.com' } })).status, 409);
  assert.equal((await h.request('/v1/apps/crm/envs/main/domains', { method: 'POST', key, json: { host: 'not a host' } })).status, 400);
  const list = (await (await h.request('/v1/apps/crm/envs/main/domains', { key })).json()) as { host: string; status: string }[];
  assert.deepEqual(list.map((x) => [x.host, x.status]), [['shop.acme.com', 'active']]);
  await deleteApp(h.ctx, app, 'test');
  assert.equal((await ask('shop.acme.com')).status, 404);
});
