/**
 * Email code sign-in on an app origin (docs/email-sign-in.md): `POST /.boxlite/auth/email/start`
 * mails a 6-digit code through the App's sender, `POST /.boxlite/auth/email/verify` trades it for a
 * session. Codes are stored hashed, live 10 minutes, allow 5 tries and only work in the browser
 * that asked for them (the `bxl_login` nonce, as the OAuth handoff).
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { safeEqual, sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { HttpError } from '../errors.js';
import { hostCookieName, readCookie, setCookieValue } from '../http/cookies.js';
import { escapeHtml } from '../http/html.js';
import { SESSION_COOKIE_MAX_AGE_S, SESSION_COOKIE_NAME, SESSION_TTL_S, appSecure, loginNonceName } from './config.js';
import { senderOf, sendMail } from './email-sender.js';
import { mirrorUser } from './mirror.js';
import { authLog } from './oauth-flow.js';
import { htmlPage, noAccessPage, redirect } from './pages.js';
import { safeNext } from './paths.js';
import { createSession, upsertUser } from './sessions.js';
import { verifiedDomainOf } from '../services/domains.js';

const CODE_TTL_S = 10 * 60;
const MAX_TRIES = 5;
const PER_ADDRESS_PER_HOUR = 5;
const PER_ENV_PER_HOUR = 100;
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;

export const emailReady = (ctx: Pick<Ctx, 'store'>, app: AppRow) => senderOf(ctx, app) !== undefined;

/** The email part of the login page: the address form, with `next` carried through. */
export function emailForm(next: string, email = ''): string {
  return `<form class="signin" method="post" action="/.boxlite/auth/email/start">
<input type="email" name="email" required autocomplete="email" placeholder="you@example.com" value="${escapeHtml(email)}" aria-label="Email address">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Email me a sign-in code</button></form>`;
}

function codeForm(email: string, next: string, note: string): string {
  return `<h1>Check your email</h1><p>${note}</p>
<form class="signin" method="post" action="/.boxlite/auth/email/verify">
<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code" aria-label="Sign-in code" autofocus>
<input type="hidden" name="email" value="${escapeHtml(email)}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Sign in</button></form>
<p class="or"><a href="/.boxlite/auth/login?next=${encodeURIComponent(next)}">Use a different address or send a new code</a></p>`;
}

/** A form post from this origin only: a page elsewhere must not start or finish someone's sign-in. */
function sameOrigin(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return (headers.get('sec-fetch-site') ?? 'same-origin') === 'same-origin';
  if (origin === new URL(ctx.resources.appUrl(app.name, env.name)).origin) return true;
  // Or one of the env's verified custom domains, over HTTPS (services/domains.ts).
  const u = URL.canParse(origin) ? new URL(origin) : null;
  return !!u && u.protocol === 'https:' && verifiedDomainOf(ctx, env, u.host) === u.hostname;
}

const count = (ctx: Ctx, sql: string, ...args: (string | number)[]) => ctx.store.get<{ n: number }>(sql, ...args)?.n ?? 0;

export async function startEmail(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers, form: URLSearchParams): Promise<Response> {
  const next = safeNext(form.get('next')) ?? '/';
  const email = (form.get('email') ?? '').trim().toLowerCase();
  if (!sameOrigin(ctx, app, env, headers)) return htmlPage('Sign-in refused', '<h1>Start the sign-in from this site</h1>', 403);
  const sender = senderOf(ctx, app);
  if (!sender) return htmlPage('Sign-in unavailable', '<h1>Email sign-in is not available on this site</h1>', 400);
  if (!EMAIL_RE.test(email) || email.length > 254) return htmlPage('Sign in', `<h1>That is not an email address</h1>${emailForm(next, email)}`, 400);

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  if (count(ctx, 'SELECT COUNT(*) AS n FROM auth_email_codes WHERE env_id = ? AND email = ? AND created_at > ?', env.id, email, hourAgo) >= PER_ADDRESS_PER_HOUR) {
    authLog(ctx, env, 'warn', `sign-in code for ${email} not sent: ${PER_ADDRESS_PER_HOUR} codes in the last hour`);
    return htmlPage('Too many codes', '<h1>Too many codes for this address</h1><p>Use the last code you received, or try again in an hour.</p>', 429);
  }
  if (count(ctx, 'SELECT COUNT(*) AS n FROM auth_email_codes WHERE env_id = ? AND created_at > ?', env.id, hourAgo) >= PER_ENV_PER_HOUR) {
    authLog(ctx, env, 'warn', `sign-in code not sent: ${PER_ENV_PER_HOUR} codes in the last hour on this site`);
    return htmlPage('Try again later', '<h1>Sign-in codes are paused</h1><p>Too many were sent in the last hour. Try again later.</p>', 429);
  }

  // Recorded before sending, in the same synchronous step as the counts above: parallel requests
  // cannot all pass the limits, and a failed send still counts.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  const secure = appSecure(ctx, app, env);
  const nonce = readCookie(headers, loginNonceName(secure)) ?? randomBytes(24).toString('base64url');
  ctx.store.run('DELETE FROM auth_email_codes WHERE created_at < ?', new Date(Date.now() - 86_400_000).toISOString());
  ctx.store.run(
    'INSERT INTO auth_email_codes (id, env_id, email, code_hash, browser_hash, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    env.id,
    email,
    sha256hex(`${id}:${code}`),
    sha256hex(nonce),
    next,
    now(),
    new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
  );
  const host = new URL(ctx.resources.appUrl(app.name, env.name)).host;
  try {
    await sendMail(ctx, sender, {
      to: email,
      subject: `Your sign-in code for ${host}`,
      text: `Your sign-in code is ${code}\n\nEnter it on ${host} within ${CODE_TTL_S / 60} minutes. If you did not ask for it, ignore this email.\n`,
    });
  } catch (err) {
    ctx.store.run('UPDATE auth_email_codes SET used_at = ? WHERE id = ?', now(), id);
    const why = err instanceof HttpError ? `${err.message} (${err.next})` : (err as Error).message;
    authLog(ctx, env, 'error', `sign-in code for ${email} not sent: ${why}`);
    return htmlPage('Could not send the code', '<h1>We could not send the code</h1><p>The site could not send email just now. Try again in a few minutes.</p>', 502);
  }
  authLog(ctx, env, 'info', `sign-in code sent to ${email}`);
  const headersOut = new Headers({ 'set-cookie': setCookieValue(secure, loginNonceName(secure), nonce, '/', CODE_TTL_S), 'cache-control': 'no-store' });
  return htmlPage('Check your email', codeForm(email, next, `We sent a 6-digit code to <b>${escapeHtml(email)}</b>. It works for ${CODE_TTL_S / 60} minutes.`), 200, headersOut);
}

export async function verifyEmail(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers, form: URLSearchParams): Promise<Response> {
  const next = safeNext(form.get('next')) ?? '/';
  const email = (form.get('email') ?? '').trim().toLowerCase();
  const code = (form.get('code') ?? '').replace(/\s/g, '');
  if (!sameOrigin(ctx, app, env, headers)) return htmlPage('Sign-in refused', '<h1>Finish the sign-in on this site</h1>', 403);
  const secure = appSecure(ctx, app, env);
  const nonce = readCookie(headers, loginNonceName(secure));
  const row = nonce
    ? ctx.store.get<{ id: string; code_hash: string; attempts: number }>(
        'SELECT id, code_hash, attempts FROM auth_email_codes WHERE env_id = ? AND email = ? AND browser_hash = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
        env.id,
        email,
        sha256hex(nonce),
        now(),
      )
    : undefined;
  const again = `<p><a href="/.boxlite/auth/login?next=${encodeURIComponent(next)}">Send a new code</a></p>`;
  if (!row || row.attempts >= MAX_TRIES) {
    return htmlPage('Code expired', `<h1>This code no longer works</h1><p>It is older than ${CODE_TTL_S / 60} minutes, was already used, was tried too often, or was asked for in another browser.</p>${again}`, 400);
  }
  if (!/^\d{6}$/.test(code) || !safeEqual(sha256hex(`${row.id}:${code}`), row.code_hash)) {
    ctx.store.run('UPDATE auth_email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    authLog(ctx, env, 'warn', `wrong sign-in code for ${email} (try ${row.attempts + 1} of ${MAX_TRIES})`);
    const left = MAX_TRIES - row.attempts - 1;
    if (left <= 0) return htmlPage('Code expired', `<h1>Too many wrong codes</h1>${again}`, 400);
    return htmlPage('Wrong code', codeForm(email, next, `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`), 400);
  }
  if (Number(ctx.store.run('UPDATE auth_email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id).changes) !== 1) {
    return htmlPage('Code expired', `<h1>This code was already used</h1>${again}`, 400);
  }
  const user = upsertUser(ctx, app, env, 'email', { id: email, email, name: email.split('@')[0] ?? email, avatarUrl: null });
  const out = new Headers({ 'set-cookie': setCookieValue(secure, loginNonceName(secure), '', '/', 0) });
  if (user.blocked) return noAccessPage(out);
  await mirrorUser(ctx, env.id, user);
  const { token } = createSession(ctx, user, 'oauth', SESSION_TTL_S);
  out.append('set-cookie', setCookieValue(secure, hostCookieName(SESSION_COOKIE_NAME, secure), token, '/', SESSION_COOKIE_MAX_AGE_S));
  out.set('referrer-policy', 'no-referrer');
  authLog(ctx, env, 'info', `${email} signed in with email → ${next}`);
  return redirect(next, out);
}
