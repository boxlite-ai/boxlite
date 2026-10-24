import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { TOML, createApp, harness, upload } from './helpers.js';

const h = harness();
after(() => h.close());

function parse(text: string) {
  return text
    .split('\n\n')
    .filter((b) => b.includes('event:'))
    .map((b) => {
      const ev = /event: (\w+)/.exec(b)![1]!;
      const data = /data: (.*)/.exec(b)![1]!;
      const id = /id: (\d+)/.exec(b)?.[1];
      return { ev, data: JSON.parse(data), id: id ? Number(id) : undefined };
    });
}

test('the events stream follows a running deployment and ends with done', async () => {
  const key = await createApp(h);
  const snapshot = await upload(h, key, { 'boxlite.toml': TOML, 'package.json': '{}', 'package-lock.json': '{}', 'server.js': '' });
  const res = await h.request('/v1/apps/crm/envs/main/deployments', {
    method: 'POST',
    key,
    json: { kind: 'deploy', snapshot_id: snapshot, manifest: parseManifest(TOML, 'main').manifest, base_version: 0, migrations: [] },
  });
  const dep = (await res.json()) as { number: number };
  // Open the stream while the job runs; the response body only ends after `done`.
  const stream = await h.request(`/v1/apps/crm/envs/main/deployments/${dep.number}/events`, { key });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const events = parse(await stream.text());
  const last = events.at(-1)!;
  assert.equal(last.ev, 'done');
  assert.equal(last.data.status, 'live');
  assert.equal(last.data.deployment.number, dep.number);
  assert.ok(events.some((e) => e.ev === 'step' && e.data.name === 'build' && e.data.status === 'done'));
  assert.ok(events.some((e) => e.ev === 'log' && e.data.source === 'build'));
  const ids = events.map((e) => e.id!);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  // Replaying after the last-but-one event yields only `done`.
  const replay = await h.request(`/v1/apps/crm/envs/main/deployments/${dep.number}/events`, { key, headers: { 'last-event-id': String(ids.at(-2)) } });
  const again = parse(await replay.text());
  assert.deepEqual(again.map((e) => e.ev), ['done']);
});
