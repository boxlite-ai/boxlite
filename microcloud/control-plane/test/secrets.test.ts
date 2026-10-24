import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { secretValue } from '../src/orgs.js';
import { createApp, harness } from './helpers.js';

const h = harness();
after(() => h.close());

test('an agent stores an App secret with its key; the value resolves for that App only and never comes back out', async () => {
  const key = await createApp(h, 'shop');
  const other = await createApp(h, 'blog');
  const put = (k: string, name: string, json: unknown) => h.request(`/v1/apps/me/secrets/${name}`, { method: 'PUT', key: k, json });

  const stored = await put(key, 'stripe', { value: 'sk_test_123' });
  assert.equal(stored.status, 200, await stored.clone().text());
  assert.deepEqual(((await stored.json()) as { name: string; created: boolean }).name, 'app/stripe');
  assert.equal(((await (await put(key, 'app/stripe', { value: 'sk_test_456' })).json()) as { created: boolean }).created, false, 'app/<name> works too, and updates');

  const shop = h.ctx.store.appByName('shop')!;
  const blog = h.ctx.store.appByName('blog')!;
  assert.equal(secretValue(h.ctx, shop, 'app/stripe'), 'sk_test_456');
  assert.equal(secretValue(h.ctx, blog, 'app/stripe'), undefined, "another App's key never reads it");
  assert.equal((await put(other, 'stripe', { value: 'x' })).status, 200, 'the same name in another App is its own secret');
  assert.equal(secretValue(h.ctx, shop, 'app/stripe'), 'sk_test_456');

  const listed = await (await h.request('/v1/apps/me/secrets', { key })).text();
  assert.ok(listed.includes('app/stripe') && !listed.includes('sk_test'), `names only: ${listed}`);
  const activity = JSON.stringify(h.ctx.store.all('SELECT detail FROM activity'));
  assert.ok(activity.includes('app/stripe') && !activity.includes('sk_test'), 'the activity log names it, never its value');

  assert.equal((await put(key, 'has%20space', { value: 'x' })).status, 400);
  assert.equal((await put(key, 'empty', { value: '' })).status, 400);
  assert.equal((await h.request('/v1/apps/me/secrets/stripe', { method: 'DELETE', key })).status, 204);
  assert.equal(secretValue(h.ctx, shop, 'app/stripe'), undefined);
  assert.equal((await h.request('/v1/apps/me/secrets/stripe', { method: 'DELETE', key })).status, 404);
});

test('in the console, adding a secret stores the value as an App secret and references it', async () => {
  const { signConsoleSession } = await import('../src/console-auth.js');
  const cookie = `__Host-bxl_console=${signConsoleSession('test-session-secret')}`;
  const api = (path: string, init: { method?: string; json?: unknown } = {}) =>
    h.request(`/console/api${path}`, { method: init.method ?? 'GET', json: init.json, headers: { cookie, ...(init.method && init.method !== 'GET' ? { 'x-boxlite-console': '1' } : {}) } });
  const shop = h.ctx.store.appByName('shop')!;
  const names = (await (await api('/apps/shop/secrets')).json()) as { name: string }[];
  assert.ok(Array.isArray(names));
  // No deployment yet: the reference cannot be applied, but the value must not leak into an error either.
  const res = await api('/apps/shop/actions', { method: 'POST', json: { type: 'addSecret', name: 'OPENAI_API_KEY', value: 'sk-console-1' } });
  assert.ok(!(await res.text()).includes('sk-console-1'), 'the value never comes back');
  assert.equal(secretValue(h.ctx, shop, 'app/openai-api-key'), 'sk-console-1', 'stored as app/openai-api-key');
  assert.ok(((await (await api('/apps/shop/secrets')).json()) as { name: string }[]).some((s) => s.name === 'app/openai-api-key'), 'listed for "Reference a secret"');
});

test('adding a secret in the console never replaces a value other environments use', async () => {
  const { signConsoleSession } = await import('../src/console-auth.js');
  const cookie = `__Host-bxl_console=${signConsoleSession('test-session-secret')}`;
  const shop = h.ctx.store.appByName('shop')!;
  const before = secretValue(h.ctx, shop, 'app/openai-api-key');
  const res = await h.request('/console/api/apps/shop/actions', { method: 'POST', json: { type: 'addSecret', name: 'OPENAI_API_KEY', value: 'sk-from-qa' }, headers: { cookie, 'x-boxlite-console': '1' } });
  assert.equal(res.status, 409, await res.clone().text());
  assert.match(((await res.json()) as { error: { next: string } }).error.next, /Stored secret/);
  assert.equal(secretValue(h.ctx, shop, 'app/openai-api-key'), before, 'the stored value is untouched');
});
