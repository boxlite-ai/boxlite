import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetch } from 'undici';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';

/** Bodies longer than this are cut in human output; JSON carries up to BODY_MAX_JSON. */
const BODY_MAX_HUMAN = 64 * 1024;
const BODY_MAX_JSON = 1024 * 1024;

export interface CurlOptions {
  request?: string;
  data?: string;
  header?: string[];
  as?: string;
  fail?: boolean;
}

/** Appends `path` to the environment URL the control plane returned, whatever its shape. */
export function appUrlFor(base: string, path: string): URL {
  const root = new URL(base.endsWith('/') ? base : `${base}/`);
  if (/^https?:\/\//i.test(path)) {
    const full = new URL(path);
    // The App key goes along with the request, so it may only ever go to the App's own URL.
    if (full.origin !== root.origin || !full.pathname.startsWith(root.pathname)) {
      throw new MicrocloudError('usage', `${full.origin} is not this environment's URL (${root.origin}${root.pathname})`, `pass a path instead, e.g. \`boxlite-app app curl /healthz\``);
    }
    return full;
  }
  return new URL(path.replace(/^\/+/, ''), root);
}

function parseHeaders(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const i = h.indexOf(':');
    if (i <= 0) throw new MicrocloudError('usage', `header "${h}" must look like "Name: value"`, '-H "Accept: application/json"');
    out[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  if (out.authorization) throw new MicrocloudError('usage', 'the CLI sets Authorization itself (the App key)', 'drop -H "Authorization: …"; use --as <email> to act as a signed-in user');
  return out;
}

async function bodyOf(ctx: Ctx, data: string | undefined): Promise<string | undefined> {
  if (data === undefined) return undefined;
  if (!data.startsWith('@')) return data;
  try {
    return await readFile(resolve(ctx.cwd, data.slice(1)), 'utf8');
  } catch {
    throw new MicrocloudError('not_found', `cannot read ${data.slice(1)}`, 'check the path after @');
  }
}

/**
 * Requests a path of the deployed app the way a browser would, authenticated with the App key
 * (the platform's proxy accepts `Authorization: Bearer <App key>` and strips it). `--as` adds a
 * signed-in test user. Redirects are not followed, so a login redirect is visible as a 302.
 */
async function curl(ctx: Ctx, path: string, opts: CurlOptions): Promise<void> {
  const api = await ctx.appApi();
  const env = await api.getEnv();
  if (!env.url) throw new MicrocloudError('not_found', `${ctx.envName} has no URL yet`, '`boxlite-app deploy` first');
  const url = appUrlFor(env.url, path);
  const headers: Record<string, string> = { 'user-agent': 'boxlite-app-curl', accept: '*/*', ...parseHeaders(opts.header) };
  const body = await bodyOf(ctx, opts.data);
  if (body !== undefined && !headers['content-type']) {
    let json = false;
    try {
      JSON.parse(body);
      json = true;
    } catch {
      json = false;
    }
    headers['content-type'] = json ? 'application/json' : 'text/plain; charset=utf-8';
  }
  let as: { email: string; expires_at?: string } | null = null;
  if (opts.as) {
    const s = await api.createTestSession(opts.as);
    headers.cookie = headers.cookie ? `${headers.cookie}; ${s.cookie}` : s.cookie;
    as = { email: s.user?.email ?? opts.as, expires_at: s.expires_at };
  }
  const method = (opts.request ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const started = Date.now();
  const send = () =>
    fetch(url, {
      method,
      headers: { ...headers, authorization: `Bearer ${ctx.apiKey}` },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      ...(ctx.dispatcher ? { dispatcher: ctx.dispatcher } : {}),
    });
  let res;
  try {
    res = await send();
  } catch (e) {
    // The platform proxy closes idle keep-alive connections; a request can race that close and
    // die with ECONNRESET / "other side closed". Browsers retry those silently; do the same once
    // for requests that are safe to repeat.
    const code = ((e as Error & { cause?: { code?: string } }).cause?.code ?? '') as string;
    const reset = /ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code);
    if (!reset || (method !== 'GET' && method !== 'HEAD')) {
      const cause = (e as Error & { cause?: Error }).cause;
      throw new MicrocloudError('unavailable', `${method} ${url.href} failed: ${cause?.message ?? (e as Error).message}`, '`boxlite-app app services` and `boxlite-app doctor` show whether the app is up');
    }
    try {
      res = await send();
    } catch (e2) {
      const cause = (e2 as Error & { cause?: Error }).cause;
      throw new MicrocloudError('unavailable', `${method} ${url.href} failed twice: ${cause?.message ?? (e2 as Error).message}`, '`boxlite-app app services` and `boxlite-app doctor` show whether the app is up');
    }
  }
  const ms = Date.now() - started;
  const text = await res.text();
  const respHeaders = Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== 'set-cookie'));
  const setCookie = res.headers.getSetCookie();
  let bodyJson: unknown;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      bodyJson = JSON.parse(text);
    } catch {
      bodyJson = undefined;
    }
  }
  const result = {
    url: url.href,
    method,
    status: res.status,
    ok: res.ok,
    ms,
    headers: { ...respHeaders, ...(setCookie.length ? { 'set-cookie': setCookie } : {}) },
    body: text.slice(0, BODY_MAX_JSON),
    ...(bodyJson !== undefined ? { body_json: bodyJson } : {}),
    truncated: text.length > BODY_MAX_JSON,
    as,
  };
  if (opts.fail && res.status >= 400) {
    throw new MicrocloudError('http_error', `${method} ${url.pathname} answered ${res.status}`, `\`boxlite-app app logs --since 5m --level error\` shows what the app printed`, { status: res.status, url: url.href, body: text.slice(0, 2000) });
  }
  ctx.out.data(result);
  ctx.out.line(`HTTP ${res.status} ${res.statusText}  ${method} ${url.href}  ${ms} ms${as ? `  as ${as.email}` : ''}`);
  for (const [k, v] of Object.entries(respHeaders)) ctx.out.line(`${k}: ${v}`);
  for (const c of setCookie) ctx.out.line(`set-cookie: ${c}`);
  ctx.out.line('');
  if (text) ctx.out.line(text.length > BODY_MAX_HUMAN ? `${text.slice(0, BODY_MAX_HUMAN)}\n… (${text.length - BODY_MAX_HUMAN} more bytes; use --json)` : text);
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) ctx.out.next(`follow it: \`boxlite-app app curl ${res.headers.get('location')}\`${opts.as ? '' : ', or add --as qa@example.com to act as a signed-in user'}`);
  else if (res.status >= 500) ctx.out.next('`boxlite-app app logs --since 5m --level error`');
  else if (res.status === 401 || res.status === 403) ctx.out.next('add `--as qa@example.com` to act as a signed-in user');
}

function opener(): { cmd: string; args: (url: string) => string[] } {
  if (process.platform === 'darwin') return { cmd: 'open', args: (u) => [u] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: (u) => ['/c', 'start', '', u] };
  return { cmd: 'xdg-open', args: (u) => [u] };
}

/** A one-time sign-in link for a person (never the App key in a URL); opens it on a terminal. */
async function open(ctx: Ctx, opts: { printUrl?: boolean }): Promise<void> {
  const api = await ctx.appApi();
  let ticket: { url: string; expires_at?: string };
  try {
    ticket = await api.openTicket();
  } catch (e) {
    if (e instanceof MicrocloudError && (e.code === 'not_found' || e.code === 'http_404')) {
      throw new MicrocloudError('not_supported_yet', 'this control plane cannot issue open tickets yet', '`boxlite-app app status` shows the URL; open it and sign in through the console');
    }
    throw e;
  }
  const launch = !opts.printUrl && !ctx.json && ctx.io.isTTY;
  if (launch) {
    const o = opener();
    spawn(o.cmd, o.args(ticket.url), { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
  }
  ctx.out.data({ url: ticket.url, expires_at: ticket.expires_at ?? null, opened: launch });
  ctx.out.line(launch ? `opened ${ticket.url}` : ticket.url);
  if (!launch) ctx.out.next('give this one-time link to the user; it signs them in once and expires');
}

export function registerCurl(app: Command, make: MakeCtx): void {
  describe(
    app
      .command('curl <path>')
      .description('request a path of the deployed app with the App key (works for private apps); --as signs in a test user; redirects are shown, not followed')
      .option('-X, --request <method>', 'HTTP method (default GET, or POST with -d)')
      .option('-d, --data <body>', 'request body; @file reads it from a file; JSON bodies get Content-Type: application/json')
      .option('-H, --header <header>', 'extra request header "Name: value" (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
      .option('--as <email>', 'act as this signed-in end user (a 15 minute test session)')
      .option('--fail', 'exit 1 (code http_error) when the status is 400 or above')
      .action(async (path: string, opts: CurlOptions, cmd: Command) => curl(await make(cmd), path, opts)),
    {
      json: '{ url, method, status, ok, ms, headers: Record<string, string | string[]>, body: string, body_json?: unknown, truncated: boolean, as: { email, expires_at } | null }',
      exits: [2, 3, 4, 6],
      online: true,
      examples: ['boxlite-app app curl /healthz', 'boxlite-app app curl /api/items -X POST -d \'{"title":"x"}\' --as qa@example.com --json', 'boxlite-app app curl /app --fail'],
    },
  );
  describe(
    app
      .command('open')
      .description('a one-time sign-in link to the app for a person: opens the browser on a terminal, else prints it')
      .option('--print-url', 'print the link instead of opening a browser')
      .action(async (opts: { printUrl?: boolean }, cmd: Command) => open(await make(cmd), opts)),
    { json: '{ url: string, expires_at: string | null, opened: boolean }', exits: [2, 3], online: true },
  );
}
