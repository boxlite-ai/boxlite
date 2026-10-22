/** The pages and JSON errors the CP itself answers on an app origin: starting, not running, the access gate's 401. */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { escapeHtml } from '../http/html.js';

export function page(title: string, html: string, status: number, headers: Record<string, string> = {}): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headers['x-refresh'] ? `<meta http-equiv="refresh" content="${headers['x-refresh']}">` : ''}<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}code{background:#f3f3f3;padding:0 .25rem}.hint{color:#666;font-size:13px}</style></head><body>${html}</body></html>`;
  const h: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers };
  delete h['x-refresh'];
  return new Response(doc, { status, headers: h });
}

export function startingPage(app: string): Response {
  return page(`Starting ${app}…`, `<h1>Starting ${escapeHtml(app)}…</h1><p>The app was asleep and is waking up. This page reloads by itself.</p>`, 503, {
    'retry-after': '3',
    'x-refresh': '3',
    'x-boxlite-starting': '1',
  });
}

/** 503 for a Box that will not come up by waiting; the reason is in the env's `system` log. */
export function notRunningPage(app: string, why: string): Response {
  return page(`${app} is not running`, `<h1>${escapeHtml(app)} is not running</h1><p>${escapeHtml(why)}</p><p class="hint">The app's owner sees the details in the BoxLite console, under Logs (source system).</p>`, 503, { 'retry-after': '60' });
}

export const wantsHtml = (headers: Headers) => (headers.get('accept') ?? '').includes('text/html');

export function jsonError(status: number, code: string, message: string, next: string): Response {
  return new Response(JSON.stringify({ error: { code, message, next } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** The 401 of the access gate: what happened and how to get in, for people and for agents. */
export function gatePage(ctx: Ctx, app: AppRow, env: EnvRow, access: string, headers: Headers): Response {
  const label = env.name === 'main' ? app.name : `${app.name} (${env.name})`;
  if (!wantsHtml(headers)) {
    return jsonError(401, 'unauthenticated', `${label} is ${access}`, 'open it from the BoxLite console, or send Authorization: Bearer <App key>');
  }
  const consoleLink = `${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}`;
  return page(
    `${label} is ${access}`,
    `<h1>${escapeHtml(label)} is ${escapeHtml(access)}</h1>
<p>Only its owners can open this app, and this browser is not signed in to it yet.</p>
<p><a href="${escapeHtml(consoleLink)}">Open it from the BoxLite console</a> with <b>Open app</b>. That signs this browser in to the app for 7 days.</p>
<p class="hint">Coding agents: send the App key as <code>Authorization: Bearer $BOXLITE_API_KEY</code>.</p>`,
    401,
  );
}
