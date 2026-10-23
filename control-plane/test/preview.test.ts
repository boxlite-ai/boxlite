import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { capturePreview, previewAttempt, previewMeta } from '../src/preview.js';
import { createApp, harness } from './helpers.js';

// A real headless Chrome against a local page; skipped where none is installed.
const CHROME = process.env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const h = harness();
after(() => h.close());

test('a page that keeps polling and holds a request open still gets its picture', { skip: !existsSync(CHROME) && 'no Chrome here' }, async () => {
  // What bookclub does: fetches its data, then never lets the network go idle.
  const server = createServer((req, res) => {
    if (req.url === '/hold') return; // never answered
    if (req.url === '/poll') return res.end('{}');
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Book club</h1><script>fetch("/hold");setInterval(()=>fetch("/poll"),200)</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await createApp(h);
    const app = h.ctx.store.appByName('crm')!;
    const env = h.ctx.store.envByName(app.id, 'main')!;
    h.ctx.resources.appUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h.ctx.resources.effectiveAccess = () => 'public';
    process.env.CHROMIUM_PATH = CHROME;
    capturePreview(h.ctx, app.id, env.id, 1);
    assert.equal(previewAttempt(env.id)?.taking, true, 'the console can show it is being taken');
    const t0 = Date.now();
    while (!previewMeta(h.ctx, env.id) && !previewAttempt(env.id)?.failed && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
    assert.equal(previewAttempt(env.id)?.failed ?? null, null, JSON.stringify(previewAttempt(env.id)));
    assert.equal(previewMeta(h.ctx, env.id)?.deployment, 1);
    assert.ok(Date.now() - t0 < 15_000, 'it does not wait for an idle network that never comes');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the platform\'s own page (not deployed, unavailable) never becomes the app\'s picture', { skip: !existsSync(CHROME) && 'no Chrome here' }, async () => {
  const { brandPage } = await import('../src/http/brand-page.js');
  const server = createServer(async (_req, res) => {
    const page = brandPage({ title: 'Coming soon', tone: 'stopped', label: 'Coming soon', heading: 'This site is not live yet' }, 503);
    res.writeHead(page.status, Object.fromEntries(page.headers));
    res.end(await page.text());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const app = h.ctx.store.appByName('crm')!;
    const env = h.ctx.store.envByName(app.id, 'main')!;
    const before = previewMeta(h.ctx, env.id);
    h.ctx.resources.appUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    capturePreview(h.ctx, app.id, env.id, 2);
    const t0 = Date.now();
    while (!previewAttempt(env.id)?.failed && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200));
    assert.match(previewAttempt(env.id)?.failed?.reason ?? '', /503 page instead of the app/);
    assert.deepEqual(previewMeta(h.ctx, env.id), before, 'the old picture stays');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
