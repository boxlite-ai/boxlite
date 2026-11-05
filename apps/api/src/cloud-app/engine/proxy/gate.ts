/** App origin access through an organization key, a public path, or a one-time ticket's cookie. */
import { randomBytes } from 'node:crypto'
import { bearer, safeEqual, sha256hex } from '../auth'
import type { AppRow, EnvRow } from '../db'
import { now } from '../db'
import type { Ctx } from '../ctx'
import { isPublicPath, safeNext } from '../enduser/paths'
import { fail } from '../errors'
import { hostCookieName, isSecureUrl, readCookie, setCookieValue } from '../http/cookies'
import { escapeHtml } from '../http/html'
import { isResponse } from '../http/response'
import { signExpiring, verifyExpiring } from '../http/signed-token'
import { jsonError, page } from './pages'
import { TEST_SESSION_TTL_S } from '../enduser/config'
import { createTestSession } from '../enduser/management'
import type { EndUserRole } from '../enduser/role'

/**
 * Access credentials for an App environment:
 *   - A one-time ticket from the management API sets a host-only `bxl_access` cookie.
 *   - A valid organization key with `read:apps` grants access to its organization's Apps.
 *     Recognized platform credentials are consumed at this boundary. Other authorization headers
 *     belong to the App and continue through the public or cookie access checks.
 */

const ACCESS_COOKIE = 'bxl_access'
const accessName = async (ctx: Ctx, app: AppRow, env: EnvRow) =>
  hostCookieName(ACCESS_COOKIE, isSecureUrl(await ctx.resources.appUrl(app.name, env.name)))
const TICKET_TTL_S = 60
const ACCESS_TTL_S = 7 * 24 * 3600

// ---- access cookie and tickets --------------------------------------------------

/** `<env id>.<expiry>.<hmac>` binds the cookie to one environment. */
export function signAccess(secret: string, envId: string, ttlSeconds = ACCESS_TTL_S): string {
  return signExpiring(secret, 'app-access', envId, ttlSeconds, '.')
}

function verifyAccess(secret: string, value: string | undefined, envId: string): boolean {
  return verifyExpiring(secret, 'app-access', value, '.') === envId
}

/**
 * A one-time link into the env's origin that sets its access cookie. Stored hashed, 60 s. With `as`,
 * opening it also signs the browser in as that test user (a 15-minute test session, made when the
 * link is opened, so no session token is ever stored or put in the link).
 */
export async function createOpenTicket(
  ctx: Ctx,
  app: AppRow,
  env: EnvRow,
  next: string | null | undefined,
  actor: string,
  as?: { email: string; role: EndUserRole },
): Promise<{ url: string; expires_at: string }> {
  const path = safeNext(next)
  if (path === null) throw fail('invalid_request', '`next` must be a path inside the app, like /deals?x=1')
  const ticket = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + TICKET_TTL_S * 1000).toISOString()
  await ctx.store.run('DELETE FROM open_tickets WHERE expires_at < ?', now())
  if (as && !(await ctx.resources.currentSpec(env))?.auth)
    throw fail(
      'conflict',
      `sign-in is not enabled for ${app.name}/${env.name}`,
      'add [auth] to boxlite.toml and deploy, or open without --as',
    )
  await ctx.store.run(
    'INSERT INTO open_tickets (hash, env_id, next, created_by, created_at, expires_at, as_email, as_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256hex(ticket),
    env.id,
    path,
    actor,
    now(),
    expiresAt,
    as?.email ?? null,
    as?.role ?? null,
  )
  return {
    url: `${await ctx.resources.appUrl(app.name, env.name)}/.boxlite/open?t=${ticket}&next=${encodeURIComponent(path)}`,
    expires_at: expiresAt,
  }
}

/** Once per ticket: the UPDATE only matches an unused, unexpired ticket of this env. Null when it did not. */
async function consumeTicket(
  ctx: Ctx,
  env: EnvRow,
  ticket: string,
): Promise<{ as_email: string | null; as_role: string | null; created_by: string } | null> {
  if (!ticket) return null
  const ts = now()
  const hash = sha256hex(ticket)
  if (
    Number(
      (
        await ctx.store.run(
          'UPDATE open_tickets SET used_at = ? WHERE hash = ? AND env_id = ? AND used_at IS NULL AND expires_at > ?',
          ts,
          hash,
          env.id,
          ts,
        )
      ).changes,
    ) !== 1
  )
    return null
  return (await ctx.store.get('SELECT as_email, as_role, created_by FROM open_tickets WHERE hash = ?', hash)) ?? null
}

export /** `/.boxlite/open?t=…`: a valid ticket sets the access cookie (and a test session, with --as) and redirects to `next`. */
async function openWithTicket(ctx: Ctx, app: AppRow, env: EnvRow, url: URL): Promise<Response> {
  const next = safeNext(url.searchParams.get('next')) ?? '/'
  const noRef = { 'referrer-policy': 'no-referrer' }
  const ticket = await consumeTicket(ctx, env, url.searchParams.get('t') ?? '')
  if (!ticket) {
    return page(
      'Link expired',
      `<h1>This link has expired</h1><p>Links like this work once, within a minute. <a href="${escapeHtml(`${ctx.origins.consoleUrl()}/dashboard/apps/${encodeURIComponent(app.id)}`)}">Open it again from your dashboard</a>.</p>`,
      401,
      noRef,
    )
  }
  const secure = isSecureUrl(await ctx.resources.appUrl(app.name, env.name))
  const headers = new Headers({ location: next, 'cache-control': 'no-store', ...noRef })
  headers.append(
    'set-cookie',
    setCookieValue(
      secure,
      await accessName(ctx, app, env),
      signAccess(ctx.config.sessionSecret, env.id),
      '/',
      ACCESS_TTL_S,
    ),
  )
  if (ticket.as_email) {
    const s = await createTestSession(
      ctx,
      app,
      env,
      ticket.as_email,
      ticket.created_by,
      ticket.as_role === 'owner' ? 'owner' : 'user',
    )
    headers.append(
      'set-cookie',
      setCookieValue(secure, s.cookie_name, s.cookie.slice(s.cookie_name.length + 1), '/', TEST_SESSION_TTL_S),
    )
  }
  return new Response(null, { status: 302, headers })
}

// ---- the gate --------------------------------------------------------------------

/** `Authorization` on an app origin: `none` (absent or the app's own scheme), `ok` (strip it), or a 401. */
async function keyGate(ctx: Ctx, app: AppRow, headers: Headers): Promise<'none' | 'ok' | Response> {
  const token = bearer(headers.get('authorization') ?? undefined)
  if (!token) return 'none'
  const credential = await ctx.credentials.authenticate(token)
  if (!credential) return 'none'
  if (credential.organizationId === app.org_id && credential.canReadApps) return 'ok'
  return jsonError(
    401,
    'unauthenticated',
    'this organization API key does not grant access to the App',
    'use an API key with read:apps from the organization that owns the App',
  )
}

type Gate = { ok: true; stripAuthorization: boolean } | { ok: false; refusal: Response | null; access: string }

/**
 * HTTP and WebSocket share the gate. A recognized organization key must pass its own checks
 * before public paths or ticket cookies are considered.
 */
export async function accessGate(ctx: Ctx, app: AppRow, env: EnvRow, headers: Headers, path: string): Promise<Gate> {
  const key = await keyGate(ctx, app, headers)
  if (isResponse(key)) return { ok: false, refusal: key, access: 'private' }
  if (key === 'ok') return { ok: true, stripAuthorization: true }
  const access = await ctx.resources.effectiveAccess(env)
  if (isPublicPath((await ctx.resources.currentSpec(env))?.public_paths ?? [], path))
    return { ok: true, stripAuthorization: false }
  if (
    access === 'public' ||
    verifyAccess(ctx.config.sessionSecret, readCookie(headers, await accessName(ctx, app, env)), env.id)
  )
    return { ok: true, stripAuthorization: false }
  return { ok: false, refusal: null, access }
}
