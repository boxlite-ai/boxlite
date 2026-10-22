/**
 * What the CP itself answers on an app origin when the app cannot: starting, not available, not
 * deployed, too slow, not answering, private. People get a BoxLite page (http/brand-page.ts) that
 * says what happened and what to do; programs (no text/html in Accept) get JSON with a `next`.
 */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { brandPage, type BrandPage } from '../http/brand-page.js';

export const wantsHtml = (headers: Headers) => (headers.get('accept') ?? '').includes('text/html');

export function jsonError(status: number, code: string, message: string, next: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message, next } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** The App's name, with its environment when that is not main. */
const labelOf = (app: AppRow, env: EnvRow) => (env.name === 'main' ? app.name : `${app.name} (${env.name})`);
const consoleLink = (ctx: Ctx, app: AppRow, env: EnvRow, tab = 'overview') =>
  `${ctx.origins.consoleUrl()}/console/dashboard/apps/${encodeURIComponent(app.name)}?tab=${tab}${env.name === 'main' ? '' : `&env=${encodeURIComponent(env.name)}`}`;

/** A page for people, JSON for programs, with the same status and headers. */
function answer(headers: Headers, status: number, page: BrandPage, json: { code: string; message: string; next: string }, extra: Record<string, string> = {}): Response {
  if (!wantsHtml(headers)) return jsonError(status, json.code, json.message, json.next, extra);
  return brandPage(page, status, extra);
}

/** "photos · main", top right of every page about one app. */
const contextOf = (app: AppRow, env: EnvRow) => `${app.name} · ${env.name}`;

/** 503 while an asleep app wakes; reloads itself. */
export function startingPage(app: AppRow, env: EnvRow, headers: Headers): Response {
  const label = labelOf(app, env);
  return answer(
    headers,
    503,
    {
      title: `Starting ${label}…`,
      context: contextOf(app, env),
      tone: 'progress',
      label: 'Starting',
      heading: `Waking up ${label}`,
      lines: ['It sleeps while nobody uses it and is starting now.', 'Usually 5 to 20 seconds. This page moves on to the app by itself.'],
      refreshSeconds: 3,
    },
    { code: 'starting', message: `${label} is waking up`, next: 'retry after the seconds in Retry-After; it answers as soon as it is up' },
    { 'retry-after': '3', 'x-boxlite-starting': '1' },
  );
}

/** 503 for an app that will not come up by waiting; the reason is in the env's `system` log. */
export function notRunningPage(ctx: Ctx, app: AppRow, env: EnvRow, reason: 'wake_failed' | 'box_missing', headers: Headers): Response {
  const label = labelOf(app, env);
  const lines =
    reason === 'wake_failed'
      ? ['It was asleep and could not be started just now.', 'Try again in a minute.']
      : ['It is being set up again and is not serving yet.', 'Try again after its next deployment.'];
  return answer(
    headers,
    503,
    {
      title: `${label} is not available`,
      context: contextOf(app, env),
      tone: 'stopped',
      label: 'Unavailable',
      heading: `${label} is not available right now`,
      lines,
      action: { href: '', text: 'Try again' },
      hint: 'Own this app? Its logs say what happened.',
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Open it in the BoxLite console' },
    },
    { code: 'unavailable', message: `${label} is not running (${reason === 'wake_failed' ? 'it could not be woken' : 'its Box is gone'})`, next: 'retry in a minute; `boxlite-app app status` and `boxlite-app app logs --source system --since 10m` say why' },
    { 'retry-after': '60' },
  );
}

/** 503 for an environment nothing has been deployed to. */
export function notDeployedPage(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers): Response {
  const label = labelOf(app, env);
  return answer(
    headers,
    503,
    {
      title: `${label} is not live yet`,
      context: contextOf(app, env),
      tone: 'stopped',
      label: 'Not deployed',
      heading: `${label} is not live yet`,
      lines: ['Nothing has been deployed here yet. Check back once its first version is up.'],
      hint: 'Own this app? Hand it to your coding agent from its page.',
      hintLink: { href: consoleLink(ctx, app, env), text: 'Open it in the BoxLite console' },
    },
    { code: 'not_deployed', message: `${label} has no live deployment`, next: 'deploy it: `boxlite-app deploy`' },
  );
}

/** 504: the app took too long to start answering. */
export function timeoutPage(ctx: Ctx, app: AppRow, env: EnvRow, seconds: number, headers: Headers): Response {
  const label = labelOf(app, env);
  return answer(
    headers,
    504,
    {
      title: `${label} took too long`,
      context: contextOf(app, env),
      tone: 'error',
      label: 'Timed out',
      heading: `${label} took too long to answer`,
      lines: [`It did not start answering within ${seconds} seconds.`, 'Try again. If it keeps happening, something in the app is slow.'],
      action: { href: '', text: 'Try again' },
      hint: 'Own this app? Its logs show the slow request.',
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Open it in the BoxLite console' },
    },
    { code: 'timeout', message: `${label} did not start its response within ${seconds} s`, next: 'find the slow handler: `boxlite-app app logs --level warn --since 10m`' },
  );
}

/** 502: the app is running but refused or dropped the connection. */
export function badGatewayPage(ctx: Ctx, app: AppRow, env: EnvRow, detail: string, headers: Headers): Response {
  const label = labelOf(app, env);
  return answer(
    headers,
    502,
    {
      title: `${label} is not answering`,
      context: contextOf(app, env),
      tone: 'error',
      label: 'Not answering',
      heading: `${label} is not answering`,
      lines: ['It is running but did not take the request. It may be restarting.', 'Try again in a few seconds.'],
      action: { href: '', text: 'Try again' },
      hint: 'Own this app? Its logs say why.',
      hintLink: { href: consoleLink(ctx, app, env, 'logs'), text: 'Open it in the BoxLite console' },
    },
    { code: 'bad_gateway', message: `${label} did not accept the request: ${detail}`, next: 'see why: `boxlite-app app logs --level error --since 10m` and `boxlite-app app services`' },
  );
}

/** The 401 of the access gate: what happened and how to get in, for people and for agents. */
export function gatePage(ctx: Ctx, app: AppRow, env: EnvRow, access: string, headers: Headers): Response {
  const label = labelOf(app, env);
  const who = access === 'private' ? 'Only its owners can open it' : 'Only members of its organization can open it';
  return answer(
    headers,
    401,
    {
      title: `${label} is ${access}`,
      context: contextOf(app, env),
      tone: 'locked',
      label: access === 'private' ? 'Private' : 'Members only',
      heading: access === 'private' ? `${label} is private` : `${label} is for its organization`,
      lines: [`${who}, and this browser is not signed in to it yet.`, 'If it is yours, open it from the BoxLite console. That signs this browser in for 7 days.'],
      action: { href: consoleLink(ctx, app, env), text: 'Open in the BoxLite console' },
      hint: 'Coding agents: send the App key as `Authorization: Bearer $BOXLITE_API_KEY`.',
    },
    { code: 'unauthenticated', message: `${label} is ${access}`, next: 'open it from the BoxLite console, or send Authorization: Bearer <App key>' },
  );
}

/** A page the CP shows on an app origin for something else (e.g. sign-in), in the same look. */
export function page(title: string, bodyHtml: string, status: number, headers: Record<string, string> = {}): Response {
  return brandPage({ title, tone: status >= 500 ? 'error' : 'stopped', label: title, bodyHtml }, status, headers);
}
