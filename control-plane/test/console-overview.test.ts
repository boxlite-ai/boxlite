import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { signConsoleSession } from '../src/console-auth.js';
import { presentLogLines, type RawLogLine } from '../src/console-logs.js';
import type { Deployment } from '../src/db.js';
import { createApp, harness, type Harness } from './helpers.js';

// What the console's Overview and Logs read beyond the raw CP state: the signed-in users metric
// (app_sessions), the screenshot of the live URL (preview.ts) and the curated log stream
// (console-logs.ts).

let h: Harness;
const cookie = `__Host-bxl_console=${signConsoleSession('test-session-secret')}`;

beforeEach(() => {
  h?.close();
  h = harness();
});
after(() => h.close());

const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

function mainEnv(name = 'crm') {
  const app = h.ctx.store.appByName(name)!;
  return { app, env: h.ctx.store.envByName(app.id, 'main')! };
}

function addUser(appId: string, envId: string, n: number): string {
  const id = `user-${n}`;
  h.ctx.store.run(
    'INSERT INTO app_users (id, app_id, env_id, provider, provider_user_id, email, name, avatar_url, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    appId,
    envId,
    'github',
    `gh-${n}`,
    `u${n}@acme.com`,
    null,
    null,
    iso(Date.now() - 48 * HOUR),
    iso(Date.now()),
  );
  return id;
}

function addSession(appId: string, envId: string, userId: string, from: number, until: number, revoked: number | null = null): void {
  h.ctx.store.run(
    'INSERT INTO app_sessions (token_hash, user_id, app_id, env_id, kind, created_at, last_seen, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `hash-${userId}-${from}`,
    userId,
    appId,
    envId,
    'oauth',
    iso(from),
    iso(from),
    iso(until),
    revoked === null ? null : iso(revoked),
  );
}

test('signed-in users count distinct users with a live session in each hour, without any traffic', async () => {
  await createApp(h);
  const { app, env } = mainEnv();
  const at = Date.parse('2026-10-22T12:30:00.000Z');
  const end = Math.ceil(at / HOUR) * HOUR; // 13:00, the end of the last bucket
  const start = end - 24 * HOUR;
  const a = addUser(app.id, env.id, 1);
  const b = addUser(app.id, env.id, 2);
  // a: two sessions in the last three hours count once per hour.
  addSession(app.id, env.id, a, end - 3 * HOUR + 60_000, end + 10 * HOUR);
  addSession(app.id, env.id, a, end - 2 * HOUR + 60_000, end + 10 * HOUR);
  // b: signed out (revoked) during the hour 05:00–06:00.
  addSession(app.id, env.id, b, start + 2 * HOUR + 60_000, end + 10 * HOUR, start + 5 * HOUR + 60_000);
  // an expired session long before the window is not counted.
  addSession(app.id, env.id, b, start - 30 * HOUR, start - 20 * HOUR);

  const m = h.ctx.accessLog.metrics(env.id, at);
  assert.ok(m, 'sessions alone make the metrics');
  assert.equal(m.activeUsers.length, 24);
  assert.deepEqual(m.activeUsers.slice(0, 2), [0, 0]);
  assert.deepEqual(m.activeUsers.slice(2, 6), [1, 1, 1, 1]);
  assert.equal(m.activeUsers[6], 0);
  assert.deepEqual(m.activeUsers.slice(21), [1, 1, 1]);
  // No requests: no latency to report, rather than "0 ms".
  assert.ok(m.p95Ms.every((v) => v === null));
  assert.equal(m.requests.reduce((x, y) => x + y, 0), 0);
});

test('an env with neither traffic nor sessions has no metrics; an hour without requests has no p95', async () => {
  await createApp(h);
  const { env } = mainEnv();
  const at = Date.parse('2026-10-22T12:30:00.000Z');
  assert.equal(h.ctx.accessLog.metrics(env.id, at), null);
  h.ctx.accessLog.record(env.id, { ts: '2026-10-22T10:10:00.000Z', method: 'GET', path: '/', status: 200, ms: 40 });
  h.ctx.accessLog.record(env.id, { ts: '2026-10-22T10:20:00.000Z', method: 'GET', path: '/', status: 502, ms: 90 });
  const m = h.ctx.accessLog.metrics(env.id, at)!;
  assert.equal(m.requests[21], 2);
  assert.equal(m.errors[21], 1);
  assert.equal(m.p95Ms[21], 90);
  assert.equal(m.p95Ms[23], null);
  assert.deepEqual(m.activeUsers, Array.from({ length: 24 }, () => 0));
});

test('the detail view and the preview route serve the last screenshot of the live URL', async () => {
  await createApp(h);
  const { env } = mainEnv();
  const get = (path: string) => h.request(`/console/api${path}`, { headers: { cookie } });

  // Nothing deployed: no picture, and the route says so.
  assert.equal((await (await get('/apps/crm')).json()).preview, null);
  assert.equal((await get('/apps/crm/preview?env=main')).status, 404);

  // A capture of #2 (preview.ts writes these two files after a deployment goes live).
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  mkdirSync(join(h.dir, 'previews'), { recursive: true });
  writeFileSync(join(h.dir, 'previews', `${env.id}.jpg`), jpeg);
  writeFileSync(join(h.dir, 'previews', `${env.id}.json`), JSON.stringify({ capturedAt: '2026-10-22T10:00:00.000Z', deployment: 2 }));
  // Only an env with a live deployment shows it.
  h.ctx.store.updateEnv(env.id, { live_deployment: 2 });

  const detail = await (await get('/apps/crm')).json();
  assert.deepEqual(detail.preview, { src: '/apps/crm/preview?env=main&v=2026-10-22T10%3A00%3A00.000Z', capturedAt: '2026-10-22T10:00:00.000Z', releaseId: '#2' });
  assert.equal(detail.appId, mainEnv().app.id);
  const res = await get(detail.preview.src);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);
});

// ---- the curated log stream ------------------------------------------------------------

const line = (n: number, source: string, level: string, text: string, deployment: number | null = 3): RawLogLine => ({
  id: `l${n}`,
  ts: `2026-10-22T10:00:${String(n).padStart(2, '0')}.000Z`,
  source,
  level,
  line: text,
  deployment,
});

const dep = (over: Partial<Deployment>): Deployment =>
  ({ number: 3, kind: 'deploy', by: 'key:…abcd', started_at: '2026-10-22T10:00:00.000Z', live_at: '2026-10-22T10:00:12.500Z', ...over }) as Deployment;

test('the console reads milestones for people and keeps platform detail behind its source', () => {
  const out = presentLogLines(
    [
      line(1, 'system', 'info', 'deploy #3: snapshot snap_abc extracted to /home/boxlite/app/releases/3'),
      line(2, 'build', 'error', 'npm notice New major version of npm available! 10.9.8 -> 12.2.0'),
      line(3, 'build', 'error', 'npm ERR! code ERESOLVE'),
      line(4, 'system', 'info', 'applying migration 0003_add_deals.sql'),
      line(5, 'system', 'info', 'applying migration 0004_index.sql'),
      line(6, 'system', 'info', 'applied 2 migration(s)'),
      line(7, 'system', 'info', 'deployment #3 is live at https://10001-d-x.proxy.dev.boxlite.ai'),
      line(8, 'web', 'info', 'listening on 20000'),
      line(9, 'system', 'error', 'service web exited with code 143 after 23m31.936s; restarting in 1s'),
      line(10, 'system', 'error', 'health check for web: unhealthy after 25ms'),
      line(11, 'access', 'error', 'GET /api/deals 502 40ms', null),
      line(12, 'system', 'error', 'failed at build: build step 2 (npm run build) exited with code 1', 4),
      line(13, 'system', 'error', 'deployment #4 failed at step build: build step 2 (npm run build) exited with code 1 (previous release stays live)', 4),
      line(14, 'build', 'error', 'npm warn exec The following package was not found and will be installed: tsc@2.0.4', 4),
    ],
    (n) => (n === 3 ? dep({}) : undefined),
  );
  const byId = new Map(out.map((l) => [l.id, l]));
  // Newest first.
  assert.equal(out[0]!.id, 'l14');

  assert.deepEqual(byId.get('l7'), { id: 'l7', ts: line(7, '', '', '').ts, source: 'deploy', level: 'info', line: '#3 is live · by key …abcd in 13 s', deployment: 3, detail: false });
  assert.equal(byId.get('l6')!.source, 'db');
  assert.equal(byId.get('l6')!.line, '2 migrations applied: 0003_add_deals.sql, 0004_index.sql (#3)');
  assert.equal(byId.get('l13')!.line, '#4 failed at build: build step 2 (npm run build) exited with code 1');
  assert.equal(byId.get('l13')!.level, 'error');
  // The orchestrator's duplicate of that failure stays for the CLI, out of the console's way.
  assert.equal(byId.get('l12')!.detail, true);

  // Platform chatter is detail; the app's own output is not.
  assert.equal(byId.get('l1')!.detail, true);
  assert.equal(byId.get('l4')!.detail, true);
  assert.equal(byId.get('l8')!.detail, false);
  // stderr progress of a build tool is not an error; a real build error is, and stays in view.
  assert.equal(byId.get('l2')!.level, 'info');
  assert.equal(byId.get('l2')!.detail, true);
  assert.equal(byId.get('l3')!.level, 'error');
  assert.equal(byId.get('l3')!.detail, false);
  // SIGTERM is a planned stop, not a crash; a failing health check stays a visible error.
  assert.equal(byId.get('l9')!.level, 'info');
  assert.equal(byId.get('l9')!.detail, true);
  assert.equal(byId.get('l10')!.level, 'error');
  assert.equal(byId.get('l10')!.detail, false);
  // A build tool's warning is a warning even when it names something "not found"; it stays with the build output.
  assert.equal(byId.get('l14')!.level, 'warn');
  assert.equal(byId.get('l14')!.detail, true);
    // Requests are listed only under their own source, errors included.
  assert.equal(byId.get('l11')!.detail, true);
  assert.equal(byId.get('l11')!.level, 'error');
});

test('a crash message that names a missing variable gives the console the variable to set', async () => {
  const { missingVariable } = await import('../src/console-views.js');
  assert.equal(missingVariable('Error: SLACK_TOKEN is not set'), 'SLACK_TOKEN');
  assert.equal(missingVariable('OPENAI_API_KEY is required'), 'OPENAI_API_KEY');
  assert.equal(missingVariable('Missing environment variable: STRIPE_KEY'), 'STRIPE_KEY');
  assert.equal(missingVariable('Error: connect ECONNREFUSED 127.0.0.1:5432'), undefined);
  assert.equal(missingVariable('the value is not set yet'), undefined);
  assert.equal(missingVariable(undefined), undefined);
});
