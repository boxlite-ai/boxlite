/**
 * What the CP itself answers on an app origin when the app cannot: starting, not available, not
 * deployed, too slow, not answering, private. Visitors get a plain page (http/brand-page.ts) that
 * says what happened; programs (no text/html in Accept) get JSON naming the App with a `next`.
 */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { brandPage, type BrandPage } from '../http/brand-page.js';

export const wantsHtml = (headers: Headers) => (headers.get('accept') ?? '').includes('text/html');

export function jsonError(status: number, code: string, message: string, next: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message, next } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** The App's name, with its environment when that is not main (JSON answers only, for agents). */
const labelOf = (app: AppRow, env: EnvRow) => (env.name === 'main' ? app.name : `${app.name} (${env.name})`);
const consoleLink = (ctx: Ctx, app: AppRow, env: EnvRow, tab = 'overview') =>
  `${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}?tab=${tab}${env.name === 'main' ? '' : `&env=${encodeURIComponent(env.name)}`}`;

/** A page for people, JSON for programs, with the same status and headers. */
function answer(headers: Headers, status: number, page: BrandPage, json: { code: string; message: string; next: string }, extra: Record<string, string> = {}): Response {
  if (!wantsHtml(headers)) return jsonError(status, json.code, json.message, json.next, extra);
  return brandPage(page, status, extra);
}

// These pages are for the app's visitors, not its builder: no App, environment or platform terms,
// just what happened in plain words. Its owner gets one small link to the console; agents get the
// details in the JSON answer.

/** 503 while an asleep app wakes; reloads itself. */
export function startingPage(app: AppRow, env: EnvRow, headers: Headers): Response {
  return answer(
    headers,
    503,
    {
      title: 'Just a moment…',
      tone: 'progress',
      label: 'Starting',
      heading: 'Just a moment',
      lines: ['This site is starting up and will open by itself in a few seconds.'],
      refreshSeconds: 3,
    },
    { code: 'starting', message: `${labelOf(app, env)} is waking up`, next: 'retry after the seconds in Retry-After; it answers as soon as it is up' },
    { 'retry-after': '3', 'x-boxlite-starting': '1' },
  );
}

/** 503 for an app that will not come up by waiting; the reason is in the env's `system` log. */
export function notRunningPage(ctx: Ctx, app: AppRow, env: EnvRow, reason: 'wake_failed' | 'box_missing', headers: Headers): Response {
  return answer(
    headers,
    503,
    {
      title: 'Temporarily unavailable',
      tone: 'stopped',
      label: 'Unavailable',
      heading: 'This site is temporarily unavailable',
      lines: ['Please try again in a minute.'],
      action: { href: '', text: 'Try again' },
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Site owner? See what happened' },
    },
    { code: 'unavailable', message: `${labelOf(app, env)} is not running (${reason === 'wake_failed' ? 'it could not be woken' : 'its Box is gone'})`, next: 'retry in a minute; `boxlite-app app status` and `boxlite-app app logs --source system --since 10m` say why' },
    { 'retry-after': '60' },
  );
}

/** 503 for an environment nothing has been deployed to. */
export function notDeployedPage(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers): Response {
  return answer(
    headers,
    503,
    {
      title: 'Coming soon',
      tone: 'stopped',
      label: 'Coming soon',
      heading: 'This site is not live yet',
      lines: ['Check back soon.'],
      hintLink: { href: consoleLink(ctx, app, env), text: 'Site owner? Set it up' },
    },
    { code: 'not_deployed', message: `${labelOf(app, env)} has no live deployment`, next: 'deploy it: `boxlite-app deploy`' },
  );
}

/** 504: the app took too long to start answering. */
export function timeoutPage(ctx: Ctx, app: AppRow, env: EnvRow, seconds: number, headers: Headers): Response {
  return answer(
    headers,
    504,
    {
      title: 'Taking too long',
      tone: 'error',
      label: 'Timed out',
      heading: 'This page is taking too long',
      lines: ['Please try again in a moment.'],
      action: { href: '', text: 'Try again' },
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Site owner? See the slow request' },
    },
    { code: 'timeout', message: `${labelOf(app, env)} did not start its response within ${seconds} s`, next: 'find the slow handler: `boxlite-app app logs --level warn --since 10m`' },
  );
}

/** 502: the app is running but refused or dropped the connection. */
export function badGatewayPage(ctx: Ctx, app: AppRow, env: EnvRow, detail: string, headers: Headers): Response {
  return answer(
    headers,
    502,
    {
      title: 'Something went wrong',
      tone: 'error',
      label: 'Not responding',
      heading: 'Something went wrong',
      lines: ['The site did not respond. Please try again in a few seconds.'],
      action: { href: '', text: 'Try again' },
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Site owner? See what happened' },
    },
    { code: 'bad_gateway', message: `${labelOf(app, env)} did not accept the request: ${detail}`, next: 'see why: `boxlite-app app logs --level error --since 10m` and `boxlite-app app services`' },
  );
}

/** The 401 of the access gate: for visitors a plain "private"; its owner signs in through the console. */
export function gatePage(ctx: Ctx, app: AppRow, env: EnvRow, access: string, headers: Headers): Response {
  const priv = access === 'private';
  return answer(
    headers,
    401,
    {
      title: priv ? 'Private site' : 'Members only',
      tone: 'locked',
      label: priv ? 'Private' : 'Members only',
      heading: priv ? 'This site is private' : 'This site is for members only',
      lines: [priv ? 'Only its owner can open it for now.' : 'Only members of its team can open it.'],
      hintLink: { href: consoleLink(ctx, app, env), text: priv ? 'Site owner? Open it from your dashboard' : 'Team member? Open it from your dashboard' },
    },
    { code: 'unauthenticated', message: `${labelOf(app, env)} is ${access}`, next: 'open it from the BoxLite console, or send Authorization: Bearer <App key>' },
  );
}

/** A page the CP shows on an app origin for something else (e.g. sign-in), in the same look. */
export function page(title: string, bodyHtml: string, status: number, headers: Record<string, string> = {}): Response {
  return brandPage({ title, tone: status >= 500 ? 'error' : 'stopped', label: title, bodyHtml }, status, headers);
}
