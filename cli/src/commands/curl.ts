import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetch } from 'undici';
import type { EndUserRole } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { cachedSession, cachedUrl, rememberSession, rememberUrl } from '../local-cache.js';

/** Bodies longer than this are cut in human output; JSON carries up to BODY_MAX_JSON. */
const BODY_MAX_HUMAN = 64 * 1024;
const BODY_MAX_JSON = 1024 * 1024;

export interface CurlOptions {
  request?: string;
  data?: string;
  header?: string[];
  as?: string;
  role?: string;
  fail?: boolean;
  /** Comma-separated statuses that count as success, e.g. "302" or "200,201"; any other exits 1. */
  expect?: string;
  /** Print only the response body (with --json: the parsed body when it is JSON). */
  body?: boolean;
  /** Show Set-Cookie values; by default they are redacted (session material stays out of agent logs). */
  rawHeaders?: boolean;
}

/** `name=<redacted>; Path=/; HttpOnly`: what a Set-Cookie does, without the session it carries. */
export function redactSetCookie(cookie: string): string {
  const [pair = '', ...attrs] = cookie.split(';');
  const name = pair.split('=')[0]?.trim() ?? '';
  return [`${name}=<redacted>`, ...attrs.map((a) => a.trim())].join('; ');
}

/** `--expect 302` / `200,201`: the statuses that count as success. */
function expected(value: string | undefined): number[] | null {
  if (!value) return null;
  const codes = value.split(',').map((s) => Number(s.trim()));
  if (codes.some((c) => !Number.isInteger(c) || c < 100 || c > 599)) throw new MicrocloudError('usage', `--expect takes HTTP statuses like 200 or 302,303 (got "${value}")`, '`boxlite-app app curl /path --expect 200`');
  return codes;
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
 * Requests a path of the deployed app, authenticated with the App key (the platform's proxy
 * accepts `Authorization: Bearer <App key>` and strips it). `--as` adds a signed-in test user.
 * Its Accept header is the wildcard, so an anonymous request to an `[auth].protect` path gets the API answer,
 * 401 JSON; with `-H 'Accept: text/html'` it gets what a browser gets, a 302 to
 * `/.boxlite/auth/login`. Redirects are shown, never followed.
 */
async function curl(ctx: Ctx, path: string, opts: CurlOptions): Promise<void> {
  const api = await ctx.appApi();
  // The environment's URL changes only when it is recreated: cached per project, dropped on a connection failure.
  const scope = { apiUrl: api.baseUrl, app: await ctx.appName(), env: ctx.envName, key: ctx.apiKey ?? '' };
  let envUrl = await cachedUrl(ctx.cwd, scope);
  const urlCached = envUrl !== undefined;
  if (!envUrl) {
    envUrl = (await api.getEnv()).url;
    if (!envUrl) throw new MicrocloudError('not_found', `${ctx.envName} has no URL yet`, '`boxlite-app deploy` first');
    await rememberUrl(ctx.cwd, scope, envUrl);
  }
  const url = appUrlFor(envUrl, path);
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
  const expect = expected(opts.expect);
  const sessionStarted = Date.now();
  let as: { email: string; role: EndUserRole; expires_at?: string } | null = null;
  const role = roleOption(opts.role);
  if (role && !opts.as) throw new MicrocloudError('usage', '--role needs --as <email>', `\`boxlite-app app curl <path> --as owner@example.com --role ${role}\``);
  let sessionCached = false;
  if (opts.as) {
    // A test session lasts 15 minutes: reuse it while it has more than a minute left.
    const reuse = await cachedSession(ctx.cwd, ctx.envName, opts.as, role ?? 'user');
    const s = reuse ?? (await api.createTestSession(opts.as, role));
    sessionCached = reuse !== undefined;
    const fresh = s as { cookie: string; expires_at?: string; user?: { email?: string }; role?: EndUserRole };
    const email = reuse?.email ?? fresh.user?.email ?? opts.as;
    if (!reuse && fresh.expires_at) await rememberSession(ctx.cwd, ctx.envName, opts.as, role ?? 'user', { cookie: fresh.cookie, email, expires_at: fresh.expires_at });
    headers.cookie = headers.cookie ? `${headers.cookie}; ${s.cookie}` : s.cookie;
    as = { email, role: fresh.role ?? role ?? 'user', expires_at: s.expires_at };
  }
  const sessionMs = as ? Date.now() - sessionStarted : 0;
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
      // The cached URL may be stale (the environment was recreated): the next call looks it up again.
      if (urlCached) await rememberUrl(ctx.cwd, scope, null);
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
  const setCookie = opts.rawHeaders ? res.headers.getSetCookie() : res.headers.getSetCookie().map(redactSetCookie);
  let bodyJson: unknown;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      bodyJson = JSON.parse(text);
    } catch {
      bodyJson = undefined;
    }
  }
  const redirect = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  const result = {
    url: url.href,
    method,
    status: res.status,
    // The request worked and the app answered without an error: 2xx, or a redirect (see `redirect`).
    ok: res.status < 400,
    redirect,
    ...(expect ? { expected: expect, as_expected: expect.includes(res.status) } : {}),
    ms,
    timing: { test_session_ms: sessionMs, request_ms: ms, cached: { url: urlCached, test_session: sessionCached } },
    headers: { ...respHeaders, ...(setCookie.length ? { 'set-cookie': setCookie } : {}) },
    // A JSON body is given once, parsed; any other body as text.
    ...(bodyJson !== undefined ? { body_json: bodyJson } : { body: text.slice(0, BODY_MAX_JSON) }),
    truncated: text.length > BODY_MAX_JSON,
    as,
  };
  if (expect && !expect.includes(res.status)) {
    throw new MicrocloudError('http_unexpected', `${method} ${url.pathname} answered ${res.status}, expected ${expect.join(' or ')}`, res.status >= 500 ? '`boxlite-app app logs --since 5m --level error` shows what the app printed' : res.status === 401 || res.status === 403 ? 'add `--as qa@example.com` to act as a signed-in user' : 'rerun without --expect to see the whole response', { status: res.status, url: url.href, redirect, body: text.slice(0, 2000) });
  }
  if (opts.fail && res.status >= 400) {
    throw new MicrocloudError('http_error', `${method} ${url.pathname} answered ${res.status}`, `\`boxlite-app app logs --since 5m --level error\` shows what the app printed`, { status: res.status, url: url.href, body: text.slice(0, 2000) });
  }
  if (opts.body) {
    if (ctx.json) ctx.out.data(bodyJson !== undefined ? bodyJson : text);
    else ctx.out.line(text);
    return;
  }
  ctx.out.data(result);
  ctx.out.line(`HTTP ${res.status} ${res.statusText}  ${method} ${url.href}  ${ms} ms${as ? `  as ${as.email}${as.role === 'owner' ? ' (owner)' : ''}` : ''}`);
  for (const [k, v] of Object.entries(respHeaders)) ctx.out.line(`${k}: ${v}`);
  for (const c of setCookie) ctx.out.line(`set-cookie: ${c}`);
  ctx.out.line('');
  if (text) ctx.out.line(text.length > BODY_MAX_HUMAN ? `${text.slice(0, BODY_MAX_HUMAN)}\n… (${text.length - BODY_MAX_HUMAN} more bytes; use --json)` : text);
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) ctx.out.next(`follow it: \`boxlite-app app curl ${res.headers.get('location')}\`${opts.as ? '' : ', or add --as qa@example.com to act as a signed-in user'}`);
  else if (res.status >= 500) ctx.out.next('`boxlite-app app logs --since 5m --level error`');
  else if (res.status === 401 || res.status === 403) ctx.out.next(`add \`--as qa@example.com\` to act as a signed-in user${opts.as ? '' : `; \`boxlite-app app curl ${path} -H 'Accept: text/html'\` shows the login redirect a browser gets`}`);
}

function opener(): { cmd: string; args: (url: string) => string[] } {
  if (process.platform === 'darwin') return { cmd: 'open', args: (u) => [u] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: (u) => ['/c', 'start', '', u] };
  return { cmd: 'xdg-open', args: (u) => [u] };
}

/** A one-time link that opens the app in a browser (never the App key in a URL); opens it on a terminal. */
async function open(ctx: Ctx, opts: { printUrl?: boolean; as?: string; role?: string; path?: string }): Promise<void> {
  const api = await ctx.appApi();
  const role = roleOption(opts.role);
  if (role && !opts.as) throw new MicrocloudError('usage', '--role needs --as <email>', '`boxlite-app app open --as qa@example.com --role owner`');
  let ticket: { url: string; expires_at?: string };
  try {
    ticket = await api.openTicket({ ...(opts.path ? { next: opts.path } : {}), ...(opts.as ? { as: opts.as, ...(role ? { role } : {}) } : {}) });
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
  ctx.out.data({ url: ticket.url, expires_at: ticket.expires_at ?? null, opened: launch, as: opts.as ? { email: opts.as, role: role ?? 'user' } : null });
  ctx.out.line(launch ? `opened ${ticket.url}` : ticket.url);
  // The link works once and expires a minute after it is made: never hand it to a person in a message.
  if (!launch) ctx.out.next('open it yourself now if you need a browser session; for the user, report `url` from `boxlite-app app status --json` and tell them to use Open app in the BoxLite console');
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
      .option('--role <role>', 'with --as: owner (someone who manages the App in the console) or user (default); the app sees it as X-BoxLite-User-Role')
      .option('--fail', 'exit 1 (code http_error) when the status is 400 or above')
      .option('--expect <statuses>', 'exit 1 (code http_unexpected) unless the status is one of these, e.g. 302 or 200,201')
      .option('--body', 'print only the response body (with --json, the parsed JSON)')
      .option('--raw-headers', 'show Set-Cookie values (redacted by default)')
      .action(async (path: string, opts: CurlOptions, cmd: Command) => curl(await make(cmd), path, opts)),
    {
      json: '{ url, method, status, ok (2xx or 3xx), redirect: string | null, expected?, as_expected?, ms, timing: { test_session_ms, request_ms }, headers (Set-Cookie values redacted), body_json (a JSON body) | body (text), truncated: boolean, as: { email, role, expires_at } | null }; --body: the body alone',
      exits: [2, 3, 4, 6],
      online: true,
      examples: ['boxlite-app app curl /healthz', 'boxlite-app app curl /api/items -X POST -d \'{"title":"x"}\' --as qa@example.com --json', 'boxlite-app app curl /app --fail', 'boxlite-app app curl /admin --as owner@example.com --role owner', 'boxlite-app app curl /.boxlite/auth/login --expect 302', 'boxlite-app app curl /api/leaderboard --body --json'],
    },
  );
  describe(
    app
      .command('open')
      .description('open the app in a browser through a one-time link (works once, expires after 60 s; never hand it to the user): opens the browser on a terminal, else prints it')
      .option('--print-url', 'print the link instead of opening a browser')
      .option('--as <email>', 'open it signed in as this test user (a 15-minute test session, like app curl --as): for checking signed-in pages in a browser')
      .option('--role <role>', 'with --as: owner or user (default)')
      .option('--path <path>', 'where the link lands, e.g. /app/select (default /)')
      .action(async (opts: { printUrl?: boolean; as?: string; role?: string; path?: string }, cmd: Command) => open(await make(cmd), opts)),
    {
      json: '{ url: string, expires_at: string | null, opened: boolean, as: { email, role } | null }',
      exits: [2, 3],
      online: true,
      examples: ['boxlite-app app open --print-url --as qa@example.com --path /app --json'],
    },
  );
}

/** `--role`, checked: owner or user (undefined when not given). */
export function roleOption(value: string | undefined): EndUserRole | undefined {
  if (value === undefined) return undefined;
  if (value === 'owner' || value === 'user') return value;
  throw new MicrocloudError('usage', `--role must be owner or user, not "${value}"`, '`--role owner` acts as someone who manages the App in the console');
}
