import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { newBoxToken, sha256hex } from '../src/auth.js';
import { now } from '../src/db.js';
import { DEFAULT_LIMITS, TokenBucket, limitsOf, setLimits } from '../src/limits.js';
import { ADMIN, createApp, harness, sha, type Harness } from './helpers.js';

let h: Harness;
let key: string;
let clock = 1_000_000;
const tick = (ms: number) => (clock += ms);
beforeEach(async () => {
  h?.close();
  h = harness();
  key = await createApp(h);
  clock = 1_000_000;
});
after(() => h.close());

const env = () => h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!;
function boxToken(): string {
  const token = newBoxToken();
  h.ctx.store.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), env().id, now());
  return token;
}
const lines = (n: number, text = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => ({ source: 'web', level: 'info', line: text(i) }));
const pushLogs = async (token: string, batch: unknown[]) => {
  const res = await h.request('/sv/v1/logs', { method: 'POST', key: token, json: batch });
  assert.equal(res.status, 200, 'over-limit batches still answer 200 so the supervisor never retries them');
  const { accepted, dropped } = (await res.json()) as { accepted: number; dropped: number };
  return { accepted, dropped };
};
const stored = () => h.ctx.store.logs(env().id, { limit: 100_000 });

test('the defaults are the documented ones', () => {
  assert.deepEqual(
    { ...DEFAULT_LIMITS },
    {
      logLinesPerRequest: 500,
      logLineBytes: 8192,
      logLinesPerSecond: 200,
      logBurst: 2000,
      logDropWarnMs: 60_000,
      sseSubscribersPerEnv: 20,
      sseSubscribersPerKey: 10,
      sseHeartbeatMs: 15_000,
      queuedDeploymentsPerEnv: 5,
      uploadsInFlightPerApp: 16,
      apiRequestsPerSecond: 20,
      apiBurst: 100,
    },
  );
});

test('token bucket: burst, then the steady rate', () => {
  const b = new TokenBucket(10, 20, () => clock);
  assert.equal(b.take(25), 20);
  assert.equal(b.take(1), 0);
  tick(500);
  assert.equal(b.take(10), 5);
  tick(10_000);
  assert.equal(b.take(100), 20, 'never more than the burst');
});

// ---- /sv/v1/logs ---------------------------------------------------------------------

test('log ingest keeps 500 lines per push and cuts long lines with a marker', async () => {
  setLimits(h.ctx, {}, () => clock);
  const token = boxToken();
  const out = await pushLogs(token, [...lines(1), { source: 'web', level: 'info', line: 'é'.repeat(6000) }, ...lines(598)]);
  assert.deepEqual(out, { accepted: 500, dropped: 100 });
  const all = stored();
  const long = all.find((l) => l.line.startsWith('é'))!;
  assert.ok(Buffer.byteLength(long.line) < 8192 + 64);
  assert.match(long.line, /… \[truncated \d+ bytes\]$/);
  assert.ok(!long.line.includes('�'), 'never cuts a multi-byte character in half');
  const warnings = all.filter((l) => l.source === 'system' && /log ingest limit/.test(l.line));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.line, /dropped 100 line/);
});

test('log ingest is rate limited per env with one warning per minute', async () => {
  setLimits(h.ctx, { logLinesPerSecond: 10, logBurst: 50 }, () => clock);
  const token = boxToken();
  assert.deepEqual(await pushLogs(token, lines(40)), { accepted: 40, dropped: 0 });
  assert.deepEqual(await pushLogs(token, lines(40)), { accepted: 10, dropped: 30 });
  tick(1000);
  assert.deepEqual(await pushLogs(token, lines(40)), { accepted: 10, dropped: 30 });
  const warnings = () => stored().filter((l) => l.source === 'system' && /log ingest limit/.test(l.line));
  assert.equal(warnings().length, 1, 'the second drop within the minute is only counted');
  assert.match(warnings()[0]!.line, /dropped 30 line/);
  tick(60_000);
  assert.deepEqual(await pushLogs(token, lines(1000)), { accepted: 50, dropped: 950 }, '500 per push, then the bucket (burst 50)');
  assert.equal(warnings().length, 2);
  assert.match(warnings()[1]!.line, /dropped 980 line/, 'the next warning reports everything dropped since the last one');
});

test('drops after a warning are reported when the window ends, even if pushes stop', async () => {
  setLimits(h.ctx, { logLinesPerSecond: 1, logBurst: 1, logDropWarnMs: 40 });
  const token = boxToken();
  await pushLogs(token, lines(3));
  await pushLogs(token, lines(3));
  await new Promise((r) => setTimeout(r, 80));
  const warnings = stored().filter((l) => /log ingest limit/.test(l.line));
  assert.deepEqual(
    warnings.map((w) => /dropped (\d+)/.exec(w.line)![1]),
    ['2', '3'],
  );
});

// ---- SSE ---------------------------------------------------------------------------------

async function follow(k: string) {
  const ac = new AbortController();
  const res = await h.request('/v1/apps/crm/envs/main/logs?follow=1', { key: k, signal: ac.signal });
  return { res, close: async () => { ac.abort(); await res.body?.cancel().catch(() => undefined); await new Promise((r) => setTimeout(r, 10)); } };
}

test('SSE: at most N concurrent streams per env, slots come back when a client goes away', async () => {
  setLimits(h.ctx, { sseSubscribersPerEnv: 2, sseSubscribersPerKey: 10 });
  const a = await follow(key);
  const b = await follow(key);
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  const c = await follow(key);
  assert.equal(c.res.status, 429);
  assert.equal(c.res.headers.get('retry-after'), '5');
  assert.equal(((await c.res.json()) as any).error.code, 'rate_limited');
  await a.close();
  const d = await follow(key);
  assert.equal(d.res.status, 200);
  await b.close();
  await d.close();
  assert.equal(limitsOf(h.ctx).gate.count(`sse:env:${env().id}`), 0);
});

test('SSE: per-key cap is separate from the env cap', async () => {
  setLimits(h.ctx, { sseSubscribersPerEnv: 5, sseSubscribersPerKey: 1 });
  const a = await follow(key);
  assert.equal((await follow(key)).res.status, 429);
  const admin = await follow(ADMIN);
  assert.equal(admin.res.status, 200, 'another credential still gets a stream');
  await a.close();
  await admin.close();
});

test('SSE: heartbeat comments while idle', async () => {
  setLimits(h.ctx, { sseHeartbeatMs: 20 });
  const s = await follow(key);
  const reader = s.res.body!.getReader();
  let text = '';
  const deadline = Date.now() + 2000;
  while (!text.includes(': keepalive') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /: keepalive/);
  reader.releaseLock();
  await s.close();
});

test('SSE on deployment events is capped too', async () => {
  setLimits(h.ctx, { sseSubscribersPerEnv: 1 });
  insertQueued(1);
  const a = await follow(key);
  const ev = await h.request('/v1/apps/crm/envs/main/deployments/1/events', { key });
  assert.equal(ev.status, 429);
  await a.close();
});

// ---- deployments queue ------------------------------------------------------------------

function insertQueued(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = h.ctx.store.insertDeployment(
      {
        kind: 'apply', status: 'queued', message: null, by: 'test', created_at: now(), started_at: null, finished_at: null, spec_version: null, base_version: 0,
        snapshot_id: null, steps: [], changes: [], error: null, request: { kind: 'apply' }, idempotency_key: null, release: null, box_id: null, built: false,
        restore_point: null, live_at: null,
      },
      env().id,
    );
    out.push(d.number);
  }
  return out;
}

test('at most 5 queued deployments per env; the 6th is a conflict naming the one to wait for', async () => {
  const queued = insertQueued(5);
  const res = await h.request('/v1/apps/crm/envs/main/deployments', { method: 'POST', key, json: { kind: 'rollback', to: 1 } });
  assert.equal(res.status, 409, await res.clone().text());
  const err = ((await res.json()) as any).error;
  assert.equal(err.code, 'conflict');
  assert.equal(err.wait_for, queued[0]);
  assert.match(err.next, new RegExp(`wait for #${queued[0]}`));
  assert.deepEqual(err.queued, queued);
});

// ---- uploads ---------------------------------------------------------------------------

test('concurrent file uploads per App are capped', async () => {
  setLimits(h.ctx, { uploadsInFlightPerApp: 1 });
  const files = { 'a.txt': 'aaaa', 'b.txt': 'bbbb' };
  const manifest = Object.entries(files).map(([path, c]) => ({ path, size: c.length, mode: 0o644, sha256: sha(c) }));
  const up = (await (await h.request('/v1/apps/crm/uploads', { method: 'POST', key, json: { manifest } })).json()) as { upload_id: string };
  let finish!: () => void;
  const slow = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('aa'));
      finish = () => {
        ctrl.enqueue(new TextEncoder().encode('aa'));
        ctrl.close();
      };
    },
  });
  const first = h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha('aaaa')}`, { method: 'PUT', key, body: slow, duplex: 'half' } as RequestInit);
  await new Promise((r) => setTimeout(r, 20));
  const second = await h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha('bbbb')}`, { method: 'PUT', key, body: 'bbbb' });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('retry-after'), '1');
  finish();
  assert.equal((await first).status, 200);
  assert.equal((await h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha('bbbb')}`, { method: 'PUT', key, body: 'bbbb' })).status, 200);
});

// ---- /v1 rate limit ------------------------------------------------------------------------

test('per-key rate limit on /v1 → 429 rate_limited with Retry-After; keys are independent', async () => {
  setLimits(h.ctx, { apiRequestsPerSecond: 2, apiBurst: 3 }, () => clock);
  for (let i = 0; i < 3; i++) assert.equal((await h.request('/v1/apps/crm', { key })).status, 200);
  const limited = await h.request('/v1/apps/crm', { key });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '1');
  const err = ((await limited.json()) as any).error;
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retry_after, 1);
  assert.match(err.next, /wait 1 s/);
  assert.equal((await h.request('/v1/apps/crm', { key: ADMIN })).status, 200, 'another credential has its own bucket');
  tick(500);
  assert.equal((await h.request('/v1/apps/crm', { key })).status, 200, 'refills at the steady rate');
});

test('upload file PUTs are exempt from the request rate limit', async () => {
  setLimits(h.ctx, { apiRequestsPerSecond: 1, apiBurst: 2 }, () => clock);
  const content = Array.from({ length: 5 }, (_, i) => `file ${i}`);
  const manifest = content.map((c, i) => ({ path: `f${i}.txt`, size: c.length, mode: 0o644, sha256: sha(c) }));
  const up = (await (await h.request('/v1/apps/crm/uploads', { method: 'POST', key, json: { manifest } })).json()) as { upload_id: string };
  for (const c of content) assert.equal((await h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha(c)}`, { method: 'PUT', key, body: c })).status, 200);
  assert.equal((await h.request(`/v1/apps/crm/uploads/${up.upload_id}/complete`, { method: 'POST', key })).status, 200);
  assert.equal((await h.request('/v1/apps/crm', { key })).status, 429);
});
