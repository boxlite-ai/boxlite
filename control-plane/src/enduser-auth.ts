import { recordLogs } from './logsink.js';
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { safeEqual, sha256hex } from './auth.js';
import type { AppRow, EnvRow } from './db.js';
import { now } from './db.js';
import type { Ctx } from './ctx.js';
import { fail } from './errors.js';
import { OAUTH_PROVIDERS, type OAuthProfile } from './oauth-providers.js';
import { escapeHtml } from './routes/util.js';

/**
 * End-user sign-in for apps that declare `[auth]` (PRD 3.8, case 1): platform-hosted OAuth, a user
 * pool per app env, server-side sessions, and identity headers the app proxy injects.
 *
 * Every app env has its own origin (origins.ts); the OAuth app's one registered callback lives on
 * the API origin. A sign-in therefore crosses origins:
 *
 *   app origin  /.boxlite/auth/login?next=     → login nonce cookie `bxl_login`, 302 API /auth/start
 *                                                 (provider picked first if several)
 *   API origin  /auth/start                     → PKCE verifier cookie (Path=/auth/), 302 to the provider
 *   API origin  /auth/callback/<provider>       → state + PKCE checked, user upserted and mirrored,
 *                                                 one-time handoff code (60 s, hashed), 302 to the app origin
 *   app origin  /.boxlite/auth/complete?code=   → code + login nonce checked server-side, host-only
 *                                                 `bxl_session`, 302 next
 *   app origin  /.boxlite/auth/logout|me        → as before
 *   both        /auth/jwks.json, /.boxlite/auth/jwks.json
 */

export const STATE_TTL_S = 10 * 60;
/** Idle timeout: each use pushes `expires_at` this far out. */
export const SESSION_TTL_S = 7 * 24 * 3600;
/** Absolute cookie lifetime; past it the browser drops the cookie and the user signs in again. */
export const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
export const TEST_SESSION_TTL_S = 15 * 60;
export const IDENTITY_TTL_S = 5 * 60;
/** The callback → app origin handoff code: single use, stored hashed. */
export const HANDOFF_TTL_S = 60;
const SLIDE_EVERY_MS = 60_000;

/** Each app env has its own origin, so one plain, host-only name is enough. */
export const SESSION_COOKIE_NAME = 'bxl_session';
/**
 * On https origins platform cookies carry the `__Host-` prefix. Every app origin shares the
 * proxy's parent domain, so without it a sibling app could plant a `Domain=` cookie with the
 * same name (cookie tossing) and sign a visitor in as someone else; browsers refuse to set a
 * `__Host-` cookie that has a Domain, lacks Secure or has a Path other than /.
 */
export const hostCookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);
/** Kept for callers that pass the app and env; the name no longer depends on them. */
export const sessionCookieName = (_app?: string, _env?: string) => SESSION_COOKIE_NAME;
/** On the API origin; one per env so two sign-ins in one browser do not clobber each other. */
const verifierCookieName = (envId: string) => `bxl_pkce_${envId}`;
/**
 * On the app origin, set by /.boxlite/auth/login: binds the handoff code to the browser that began
 * the sign-in, so nobody can push their own code into someone else's browser (login CSRF).
 */
const LOGIN_NONCE_COOKIE = 'bxl_login';
const sessionName = (ctx: Ctx, app: AppRow, env: EnvRow) => hostCookieName(SESSION_COOKIE_NAME, appSecure(ctx, app, env));
const loginNonceName = (secure: boolean) => hostCookieName(LOGIN_NONCE_COOKIE, secure);
const AUTH_PATH = '/auth/';
const CALLBACK_PATH = '/auth/callback/';

export function configuredProviders(ctx: Pick<Ctx, 'config'>): string[] {
  return Object.keys(OAUTH_PROVIDERS).filter((n) => ctx.config.oauth?.[n]);
}

/**
 * The OAuth app's registered callback is one fixed URL on the API origin, not one per app:
 * providers only accept pre-registered redirect URIs, and apps come and go. The `state` says which
 * app env the sign-in belongs to.
 */
export const redirectUri = (ctx: Pick<Ctx, 'config'>, provider: string) => `${ctx.config.publicUrl}${CALLBACK_PATH}${provider}`;

/** `iss` of the identity JWT. */
export const identityIssuer = (ctx: Pick<Ctx, 'config'>) => `${ctx.config.publicUrl}/auth`;

// ---- state -------------------------------------------------------------------

export interface OAuthState {
  app: string;
  env: string;
  next: string;
  provider: string;
  /** sha256 of the PKCE verifier, which waits in a cookie on the API origin's /auth/ path. */
  vh: string;
  /** sha256 of the app-origin login nonce (`bxl_login`), checked again by /.boxlite/auth/complete. */
  bh?: string;
  exp: number;
}

const stateMac = (secret: string, body: string) => createHmac('sha256', secret).update(`oauth-state:${body}`).digest('base64url');

export function signState(secret: string, payload: Omit<OAuthState, 'exp'>, ttlSeconds = STATE_TTL_S, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${stateMac(secret, body)}`;
}

export function verifyState(secret: string, token: string | null | undefined, nowMs = Date.now()): OAuthState | null {
  if (!token) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined || !safeEqual(mac, stateMac(secret, body))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    return typeof s.exp === 'number' && s.exp >= nowMs / 1000 ? s : null;
  } catch {
    return null;
  }
}

// ---- next / protect ----------------------------------------------------------

/**
 * `next` is a path on the app's own origin. Anything that could leave it is refused: a scheme,
 * `//host`, backslashes, dot segments (also percent-encoded) and control characters.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (next === null || next === undefined || next === '') return '/';
  let p = next;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.startsWith('//')) return null;
  const path = p.split(/[?#]/)[0]!;
  if (path.split('/').some((seg) => ['.', '..'].includes(seg.replace(/%2e/gi, '.')))) return null;
  return p;
}

/** Decoded, slashes collapsed, dot segments resolved: roughly what an upstream router sees. */
export function normalisePath(raw: string): string {
  try {
    return new URL(decodeURIComponent(raw).replace(/\/{2,}/g, '/'), 'http://x').pathname;
  } catch {
    return raw;
  }
}

function globRe(pattern: string): RegExp {
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  // `/app/*` also covers `/app` itself.
  const tail = pattern.endsWith('/*') ? `|${body.slice(0, -'/.*'.length)}` : '';
  return new RegExp(`^(?:${body}${tail})$`, 'i');
}

/**
 * `[auth].protect` globs against the request path. `*` spans segments. The path is also checked
 * decoded and normalised, and case-insensitively, so `/APP/x`, `/%61pp/x` or `//app/x` cannot
 * reach a route the app's router would treat as `/app/x`.
 */
export function isProtected(patterns: string[], path: string): boolean {
  if (!patterns.length) return false;
  const raw = path.split('?')[0] || '/';
  const normal = normalisePath(raw);
  return patterns.some((pat) => {
    const re = globRe(pat);
    return re.test(raw) || re.test(normal);
  });
}

// ---- signing key / identity token -------------------------------------------

interface SigningKey {
  kid: string;
  key: KeyObject;
  jwk: JsonWebKey;
}

const keys = new Map<string, SigningKey>();

/** RS256 key pair, generated once and kept in DATA_DIR so identity tokens survive restarts. */
function signingKey(ctx: Pick<Ctx, 'config'>): SigningKey {
  const dir = ctx.config.dataDir;
  const cached = keys.get(dir);
  if (cached) return cached;
  const path = join(dir, 'enduser-identity-key.pem');
  let pem: string;
  if (existsSync(path)) pem = readFileSync(path, 'utf8');
  else {
    pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(path, pem, { mode: 0o600 });
  }
  const key = createPrivateKey(pem);
  const pub = createPublicKey(key).export({ format: 'jwk' });
  // RFC 7638 thumbprint as kid.
  const kid = createHash('sha256').update(JSON.stringify({ e: pub.e, kty: pub.kty, n: pub.n })).digest('base64url');
  const out = { kid, key, jwk: { kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid } };
  keys.set(dir, out);
  return out;
}

export function jwks(ctx: Pick<Ctx, 'config'>): { keys: JsonWebKey[] } {
  return { keys: [signingKey(ctx).jwk] };
}

/**
 * RS256 identity JWT for one app env (security review F4): `aud` is that env's origin URL, which
 * the app has as BOXLITE_APP_URL, so a token captured by app A does not verify at app B.
 */
export function identityToken(ctx: Pick<Ctx, 'config' | 'resources'>, user: AppUser, app: string, env: string, nowMs = Date.now()): string {
  const k = signingKey(ctx);
  const iat = Math.floor(nowMs / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT', kid: k.kid })}.${enc({
    iss: identityIssuer(ctx),
    aud: ctx.resources.appUrl(app, env),
    sub: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    app,
    env,
    iat,
    exp: iat + IDENTITY_TTL_S,
  })}`;
  return `${input}.${sign('sha256', Buffer.from(input), k.key).toString('base64url')}`;
}

// ---- users and sessions ------------------------------------------------------

export interface AppUser {
  id: string;
  app_id: string;
  env_id: string;
  provider: string;
  provider_user_id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  first_seen: string;
  last_seen: string;
  blocked: number;
}

export interface UserView {
  id: string;
  email: string | null;
  name: string | null;
  provider: string;
  avatar_url: string | null;
  first_seen: string;
  last_seen: string;
  blocked: boolean;
  active_sessions: number;
}

function upsertUser(ctx: Ctx, app: AppRow, env: EnvRow, provider: string, p: OAuthProfile): AppUser {
  const ts = now();
  ctx.store.run(
    `INSERT INTO app_users (id, app_id, env_id, provider, provider_user_id, email, name, avatar_url, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (env_id, provider, provider_user_id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, last_seen = excluded.last_seen`,
    randomUUID(),
    app.id,
    env.id,
    provider,
    p.id,
    p.email,
    p.name,
    p.avatarUrl,
    ts,
    ts,
  );
  return ctx.store.get<AppUser>('SELECT * FROM app_users WHERE env_id = ? AND provider = ? AND provider_user_id = ?', env.id, provider, p.id)!;
}

function createSession(ctx: Ctx, user: AppUser, kind: 'oauth' | 'test', ttlSeconds: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  ctx.store.run(
    'INSERT INTO app_sessions (token_hash, user_id, app_id, env_id, kind, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256hex(token),
    user.id,
    user.app_id,
    user.env_id,
    kind,
    ts,
    ts,
    expiresAt,
  );
  return { token, expiresAt };
}

function revokeSessions(ctx: Ctx, userId: string): number {
  return Number(ctx.store.run('UPDATE app_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now(), userId).changes);
}

/** The signed-in user for a session token, sliding the expiry; blocked users lose their sessions. */
function sessionUser(ctx: Ctx, env: EnvRow, token: string | undefined): AppUser | null {
  if (!token) return null;
  const row = ctx.store.get<AppUser & { token_hash: string; kind: string; s_last_seen: string }>(
    `SELECT u.*, s.token_hash, s.kind, s.last_seen AS s_last_seen FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.env_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    sha256hex(token),
    env.id,
    now(),
  );
  if (!row) return null;
  if (row.blocked) {
    revokeSessions(ctx, row.id);
    return null;
  }
  if (Date.now() - Date.parse(row.s_last_seen) > SLIDE_EVERY_MS) {
    const ts = now();
    // Test sessions keep their fixed 15 minutes.
    if (row.kind === 'test') ctx.store.run('UPDATE app_sessions SET last_seen = ? WHERE token_hash = ?', ts, row.token_hash);
    else ctx.store.run('UPDATE app_sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', ts, new Date(Date.now() + SESSION_TTL_S * 1000).toISOString(), row.token_hash);
    ctx.store.run('UPDATE app_users SET last_seen = ? WHERE id = ?', ts, row.id);
  }
  const { token_hash: _t, kind: _k, s_last_seen: _s, ...user } = row;
  return user;
}

function userById(ctx: Ctx, env: EnvRow, id: string): AppUser {
  const u = ctx.store.get<AppUser>('SELECT * FROM app_users WHERE id = ? AND env_id = ?', id, env.id);
  if (!u) throw fail('not_found', `no user ${id} in ${env.name}`, 'list users with `boxlite-app app auth users`');
  return u;
}

function view(ctx: Ctx, u: AppUser): UserView {
  const active = ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?', u.id, now())?.n ?? 0;
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, avatar_url: u.avatar_url, first_seen: u.first_seen, last_seen: u.last_seen, blocked: Boolean(u.blocked), active_sessions: active };
}

// ---- mirror into the app database ----------------------------------------------

/** `boxlite.users` plus the RLS helper; idempotent. */
export const AUTH_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS boxlite',
  `CREATE TABLE IF NOT EXISTS boxlite.users (
    id uuid PRIMARY KEY,
    email text,
    name text,
    provider text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  )`,
  `CREATE OR REPLACE FUNCTION boxlite.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('boxlite.user_id', true), '')::uuid $$`,
];

const UPSERT_MIRROR = `INSERT INTO boxlite.users (id, email, name, provider, created_at, last_login_at) VALUES ($1, $2, $3, $4, now(), now())
  ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, provider = excluded.provider, last_login_at = now()`;

const mirrored = new WeakMap<object, Set<string>>();

export async function ensureUserMirror(ctx: Pick<Ctx, 'appdb'>, dbUrl: string): Promise<void> {
  await ctx.appdb.query(dbUrl, AUTH_SCHEMA_SQL, { write: true });
}

/** Copies the user into the env's database (when it has one). Login never fails because of it. */
async function mirrorUser(ctx: Ctx, envId: string, user: AppUser): Promise<void> {
  const env = ctx.store.envById(envId);
  if (!env?.db_url || !ctx.resources.currentSpec(env)?.database) return;
  try {
    let done = mirrored.get(ctx);
    if (!done) mirrored.set(ctx, (done = new Set()));
    if (!done.has(env.id)) {
      await ensureUserMirror(ctx, env.db_url);
      done.add(env.id);
    }
    await ctx.appdb.query(env.db_url, [UPSERT_MIRROR], { write: true, params: [user.id, user.email, user.name, user.provider] });
  } catch (err) {
    console.error(`[auth] mirror user into ${env.name} database: ${(err as Error).message}`);
  }
}

// ---- HTML --------------------------------------------------------------------

function htmlPage(title: string, body: string, status: number, headers: Headers = new Headers()): Response {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}code{background:#f3f3f3;padding:0 .25rem}a.btn{display:block;max-width:18rem;border:1px solid #ccc;border-radius:6px;padding:.6rem 1rem;margin:.6rem 0;color:#222;text-decoration:none}a.btn:hover{background:#f6f6f6}</style></head><body>${body}</body></html>`;
  return new Response(doc, { status, headers });
}

/** Host-only (no Domain), HttpOnly, SameSite=Lax; Secure when the origin that sets it is https. */
function cookie(secure: boolean, name: string, value: string, path: string, maxAge: number): string {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const apiSecure = (ctx: Pick<Ctx, 'config'>) => ctx.config.publicUrl.startsWith('https:');
const appSecure = (ctx: Ctx, app: AppRow, env: EnvRow) => ctx.resources.appUrl(app.name, env.name).startsWith('https:');

export function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const wantsHtml = (method: string, headers: Headers) => (method === 'GET' || method === 'HEAD') && (headers.get('accept') ?? '').includes('text/html');

function unauthenticated(): Response {
  return new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'sign in required' } }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

const noAccessPage = (app: string, headers?: Headers) =>
  htmlPage('No access', `<h1>You don't have access to ${escapeHtml(app)}</h1><p>The owner of this app has blocked your account.</p>`, 403, headers);

const redirect = (location: string, headers: Headers = new Headers()) => {
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
};

// ---- proxy hook (app origin) -----------------------------------------------------

export interface ProxyRequest {
  method: string;
  url: URL;
  headers: Headers;
}

/**
 * Called by the app origin after its access gate, for every request. Answers the
 * `/.boxlite/auth/*` routes itself, enforces `[auth].protect`, and otherwise returns the identity
 * headers to send upstream (none when signed out or when the app has no `[auth]`).
 */
export function identityFor(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow): Response | { headers: Record<string, string> } | Promise<Response> {
  const path = req.url.pathname || '/';
  const auth = ctx.resources.currentSpec(env)?.auth ?? null;
  if (path.startsWith('/.boxlite/auth/')) {
    if (!auth) return htmlPage('Sign-in is off', `<h1>Sign-in is not enabled for ${escapeHtml(app.name)}</h1><p>Add <code>[auth]</code> to <code>boxlite.toml</code> and deploy.</p>`, 404);
    return authRoute(ctx, req, app, env, path.slice('/.boxlite/auth'.length), auth.providers);
  }
  // The supervisor serves its control API (/.boxlite/sv/*) to the CP, so no end-user request may
  // reach /.boxlite/ upstream, however it is spelled.
  if (normalisePath(path).toLowerCase().startsWith('/.boxlite/') || normalisePath(path).toLowerCase() === '/.boxlite') return htmlPage('Not found', '<h1>Not found</h1>', 404);
  if (!auth) return { headers: {} };
  const user = sessionUser(ctx, env, readCookie(req.headers, sessionName(ctx, app, env)));
  if (user) {
    const headers: Record<string, string> = {
      'x-boxlite-user-id': user.id,
      'x-boxlite-user-provider': user.provider,
      'x-boxlite-identity': identityToken(ctx, user, app.name, env.name),
    };
    // Header values are bytes; names (and rarely emails) are not ASCII, so they travel URI-encoded.
    if (user.email) headers['x-boxlite-user-email'] = /^[\x20-\x7e]*$/.test(user.email) ? user.email : encodeURIComponent(user.email);
    if (user.name) headers['x-boxlite-user-name'] = encodeURIComponent(user.name);
    return { headers };
  }
  if (isProtected(auth.protect, path)) {
    if (!wantsHtml(req.method, req.headers)) return unauthenticated();
    return redirect(`/.boxlite/auth/login?next=${encodeURIComponent(path + req.url.search)}`);
  }
  return { headers: {} };
}

const jwksResponse = (ctx: Pick<Ctx, 'config'>) => Response.json(jwks(ctx), { headers: { 'cache-control': 'public, max-age=300' } });

function authRoute(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow, route: string, providers: string[]): Response | Promise<Response> {
  const q = req.url.searchParams;
  const secure = appSecure(ctx, app, env);
  if (route === '/jwks.json') return jwksResponse(ctx);
  if (route === '/me') {
    const user = sessionUser(ctx, env, readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure)));
    if (!user) return unauthenticated();
    return Response.json({ id: user.id, email: user.email, name: user.name, provider: user.provider, avatar_url: user.avatar_url }, { headers: { 'cache-control': 'no-store' } });
  }
  if (route === '/complete') return complete(ctx, req, app, env);
  const next = safeNext(q.get('next'));
  if (next === null) return htmlPage('Bad sign-in link', '<h1>This sign-in link is not valid</h1><p><code>next</code> must be a path inside the app.</p>', 400);
  if (route === '/logout') {
    const token = readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure));
    if (token) ctx.store.run('UPDATE app_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now(), sha256hex(token));
    return redirect(next, new Headers({ 'set-cookie': cookie(secure, hostCookieName(SESSION_COOKIE_NAME, secure), '', '/', 0) }));
  }
  if (route !== '/login') return htmlPage('Not found', '<h1>Not found</h1>', 404);

  if (sessionUser(ctx, env, readCookie(req.headers, hostCookieName(SESSION_COOKIE_NAME, secure)))) return redirect(next);
  const ready = providers.filter((p) => ctx.config.oauth?.[p] && OAUTH_PROVIDERS[p]);
  if (!ready.length) {
    return htmlPage('Sign-in unavailable', `<h1>Sign-in is not available yet</h1><p>None of this app's sign-in providers (${escapeHtml(providers.join(', '))}) is configured on this platform yet.</p>`, 503);
  }
  const asked = q.get('provider');
  if (asked !== null && !ready.includes(asked)) return htmlPage('Unknown provider', `<h1>${escapeHtml(asked)} sign-in is not available for ${escapeHtml(app.name)}</h1>`, 400);
  const provider = asked ?? (ready.length === 1 ? ready[0]! : null);
  if (!provider) {
    const buttons = ready
      .map((p) => `<a class="btn" href="${escapeHtml(`/.boxlite/auth/login?provider=${p}&next=${encodeURIComponent(next)}`)}">Continue with ${escapeHtml(OAUTH_PROVIDERS[p]!.label)}</a>`)
      .join('');
    return htmlPage(`Sign in to ${app.name}`, `<h1>Sign in to ${escapeHtml(app.name)}</h1>${buttons}`, 200);
  }
  // The provider's registered callback is on the API origin, so the PKCE verifier has to be set there.
  const nonce = randomBytes(24).toString('base64url');
  const start = new URLSearchParams({ app: app.name, env: env.name, provider, next, bh: sha256hex(nonce) });
  return redirect(`${ctx.config.publicUrl}${AUTH_PATH}start?${start}`, new Headers({ 'set-cookie': cookie(secure, loginNonceName(secure), nonce, '/', STATE_TTL_S) }));
}

/** App origin: trades the one-time handoff code from the callback for a host-only session cookie. */
async function complete(ctx: Ctx, req: ProxyRequest, app: AppRow, env: EnvRow): Promise<Response> {
  const code = req.url.searchParams.get('code') ?? '';
  const secure = appSecure(ctx, app, env);
  const nonce = readCookie(req.headers, loginNonceName(secure));
  const clear = new Headers({ 'set-cookie': cookie(secure, loginNonceName(secure), '', '/', 0) });
  const ts = now();
  const row = code ? ctx.store.get<{ user_id: string; next: string; browser_hash: string }>('SELECT user_id, next, browser_hash FROM auth_handoffs WHERE hash = ? AND env_id = ? AND used_at IS NULL AND expires_at > ?', sha256hex(code), env.id, ts) : undefined;
  const sameBrowser = !!row && !!nonce && safeEqual(sha256hex(nonce), row.browser_hash);
  const used = row && sameBrowser ? Number(ctx.store.run('UPDATE auth_handoffs SET used_at = ? WHERE hash = ? AND used_at IS NULL', ts, sha256hex(code)).changes) : 0;
  if (!row || !sameBrowser || used !== 1) {
    if (row && !sameBrowser) authLog(ctx, env, 'warn', 'sign-in rejected: it was finished in a browser that did not start it');
    return htmlPage('Sign-in expired', `<h1>Start the sign-in again</h1><p>This sign-in link was already used, is older than a minute, or was opened in a different browser.</p><p><a href="/.boxlite/auth/login">Sign in</a></p>`, 400, clear);
  }
  const user = ctx.store.get<AppUser>('SELECT * FROM app_users WHERE id = ? AND env_id = ?', row.user_id, env.id);
  if (!user) return htmlPage('Sign-in failed', '<h1>Sign-in failed</h1><p>The account is gone. Sign in again.</p>', 400);
  if (user.blocked) return noAccessPage(app.name, clear);
  const { token } = createSession(ctx, user, 'oauth', SESSION_TTL_S);
  // Path=/: the cookie covers the whole origin (without a Path it would default to /.boxlite/auth).
  clear.append('set-cookie', cookie(secure, hostCookieName(SESSION_COOKIE_NAME, secure), token, '/', SESSION_COOKIE_MAX_AGE_S));
  clear.set('referrer-policy', 'no-referrer');
  return redirect(safeNext(row.next) ?? '/', clear);
}

// ---- platform routes (API origin) ---------------------------------------------------

/** Mounted on the API origin (server.ts keeps them off app and console origins). */
export function mountEndUserAuth(root: Hono, ctx: Ctx): void {
  root.get('/auth/jwks.json', () => jwksResponse(ctx));
  root.get('/auth/start', (c) => start(ctx, c.req.raw));
  root.get('/auth/callback/:provider', (c) => callback(ctx, c.req.param('provider'), c.req.raw));
}

/** Every sign-in outcome lands in the env's `auth` log so `app logs --source auth` explains what users saw. */
function authLog(ctx: Ctx, env: EnvRow, level: 'info' | 'warn' | 'error', line: string): void {
  recordLogs(ctx, env.id, [{ ts: new Date().toISOString(), source: 'auth', level, line }]);
}

/** API origin: sets the PKCE verifier next to the callback and sends the browser to the provider. */
function start(ctx: Ctx, req: Request): Response {
  const q = new URL(req.url).searchParams;
  const app = ctx.store.appByName(q.get('app') ?? '');
  const env = app ? ctx.store.envByName(app.id, q.get('env') || 'main') : undefined;
  if (!app || !env) return htmlPage('Not found', '<h1>This app does not exist</h1>', 404);
  const auth = ctx.resources.currentSpec(env)?.auth;
  const providerName = q.get('provider') ?? '';
  const provider = OAUTH_PROVIDERS[providerName];
  const creds = ctx.config.oauth?.[providerName];
  if (!auth || !provider || !creds || !(auth.providers as string[]).includes(providerName)) {
    return htmlPage('Sign-in unavailable', `<h1>That sign-in method is not available for ${escapeHtml(app.name)}</h1>`, 400);
  }
  const next = safeNext(q.get('next'));
  if (next === null) return htmlPage('Bad sign-in link', '<h1>This sign-in link is not valid</h1><p><code>next</code> must be a path inside the app.</p>', 400);
  const bh = q.get('bh') ?? '';
  if (!/^[0-9a-f]{64}$/.test(bh)) return htmlPage('Bad sign-in link', `<h1>Start the sign-in from ${escapeHtml(app.name)}</h1>`, 400);
  const verifier = randomBytes(32).toString('base64url');
  const state = signState(ctx.config.sessionSecret, { app: app.name, env: env.name, next, provider: providerName, vh: sha256hex(verifier), bh });
  const location = provider.authorizeUrl({ creds, redirectUri: redirectUri(ctx, providerName), state, codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
  return redirect(location, new Headers({ 'set-cookie': cookie(apiSecure(ctx), verifierCookieName(env.id), verifier, AUTH_PATH, STATE_TTL_S) }));
}

async function callback(ctx: Ctx, providerName: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provider = OAUTH_PROVIDERS[providerName];
  const st = verifyState(ctx.config.sessionSecret, url.searchParams.get('state'));
  if (!provider || !st || st.provider !== providerName) {
    return htmlPage('Sign-in expired', '<h1>This sign-in link has expired</h1><p>Go back to the app and sign in again.</p>', 400);
  }
  const app = ctx.store.appByName(st.app);
  const env = app ? ctx.store.envByName(app.id, st.env) : undefined;
  if (!app || !env) return htmlPage('Not found', '<h1>This app no longer exists</h1>', 404);
  const appUrl = ctx.resources.appUrl(app.name, env.name);
  const retry = `<p><a href="${escapeHtml(`${appUrl}/.boxlite/auth/login?next=${encodeURIComponent(st.next)}`)}">Try again</a></p>`;
  const headers = new Headers({ 'cache-control': 'no-store' });
  const verifierName = verifierCookieName(env.id);
  const verifier = readCookie(req.headers, verifierName);
  headers.append('set-cookie', cookie(apiSecure(ctx), verifierName, '', AUTH_PATH, 0));

  if (url.searchParams.get('error')) authLog(ctx, env, 'warn', `${providerName} sign-in cancelled by the user (${url.searchParams.get('error')})`);
  if (url.searchParams.get('error')) return htmlPage('Sign-in cancelled', `<h1>Sign-in was cancelled</h1>${retry}`, 400, headers);
  // The verifier cookie binds the callback to the browser that started the sign-in.
  if (!verifier || !safeEqual(sha256hex(verifier), st.vh)) authLog(ctx, env, 'warn', `${providerName} sign-in rejected: callback came from a browser that did not start it, or after 10 minutes`);
  if (!verifier || !safeEqual(sha256hex(verifier), st.vh)) return htmlPage('Sign-in expired', `<h1>Start the sign-in again</h1><p>This browser did not start this sign-in, or it took longer than 10 minutes.</p>${retry}`, 400, headers);
  const creds = ctx.config.oauth?.[providerName];
  const auth = ctx.resources.currentSpec(env)?.auth;
  if (!creds || !(auth?.providers as string[] | undefined)?.includes(providerName)) return htmlPage('Sign-in unavailable', `<h1>${escapeHtml(provider.label)} sign-in is not enabled for ${escapeHtml(app.name)}</h1>`, 400, headers);
  const code = url.searchParams.get('code');
  if (!code) return htmlPage('Sign-in failed', `<h1>Sign-in failed</h1><p>${escapeHtml(provider.label)} sent no code.</p>${retry}`, 400, headers);

  let profile: OAuthProfile;
  try {
    profile = await provider.signIn({ creds, redirectUri: redirectUri(ctx, providerName), code, codeVerifier: verifier, fetch: ctx.oauthFetch ?? fetch });
  } catch (err) {
    console.error(`[auth] ${providerName} sign-in for ${app.name}/${env.name}: ${(err as Error).message}`);
    authLog(ctx, env, 'error', `${providerName} sign-in failed: ${(err as Error).message}`);
    return htmlPage('Sign-in failed', `<h1>${escapeHtml(provider.label)} sign-in failed</h1><p>${escapeHtml((err as Error).message)}</p>${retry}`, 502, headers);
  }
  const user = upsertUser(ctx, app, env, providerName, profile);
  if (user.blocked) {
    authLog(ctx, env, 'warn', `blocked user ${user.email} tried to sign in with ${providerName}`);
    revokeSessions(ctx, user.id);
    return noAccessPage(app.name, headers);
  }
  await mirrorUser(ctx, env.id, user);
  authLog(ctx, env, 'info', `${user.email} signed in with ${providerName} → ${st.next}`);
  // The session cookie must be set by the app origin itself (host-only), so hand over a one-time code.
  const handoff = randomBytes(32).toString('base64url');
  ctx.store.run('DELETE FROM auth_handoffs WHERE expires_at < ?', now());
  ctx.store.run(
    'INSERT INTO auth_handoffs (hash, env_id, user_id, next, browser_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256hex(handoff),
    env.id,
    user.id,
    st.next,
    st.bh ?? '',
    now(),
    new Date(Date.now() + HANDOFF_TTL_S * 1000).toISOString(),
  );
  headers.set('referrer-policy', 'no-referrer');
  return redirect(`${appUrl}/.boxlite/auth/complete?code=${handoff}`, headers);
}

// ---- management API (CLI routes and the console) ----------------------------------

export interface AuthStatus {
  enabled: boolean;
  providers: { name: string; status: 'ready' | 'not_configured' }[];
  protect: string[];
  login_url: string;
  users: number;
}

export function authStatus(ctx: Ctx, app: AppRow, env: EnvRow): AuthStatus {
  const auth = ctx.resources.currentSpec(env)?.auth ?? null;
  const ready = configuredProviders(ctx);
  return {
    enabled: auth !== null,
    providers: (auth?.providers ?? []).map((name) => ({ name, status: ready.includes(name) ? 'ready' : 'not_configured' })),
    protect: auth?.protect ?? [],
    login_url: `${ctx.resources.appUrl(app.name, env.name)}/.boxlite/auth/login`,
    users: ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_users WHERE env_id = ?', env.id)?.n ?? 0,
  };
}

export function redirectUris(ctx: Ctx): { provider: string; redirect_uri: string; status: 'ready' | 'not_configured' }[] {
  const ready = configuredProviders(ctx);
  return Object.keys(OAUTH_PROVIDERS).map((p) => ({ provider: p, redirect_uri: redirectUri(ctx, p), status: ready.includes(p) ? 'ready' : 'not_configured' }));
}

export function listUsers(ctx: Ctx, _app: AppRow, env: EnvRow, opts: { search?: string; limit?: number } = {}): UserView[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 10_000);
  const rows = opts.search
    ? ctx.store.all<AppUser>(
        "SELECT * FROM app_users WHERE env_id = ? AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY last_seen DESC LIMIT ?",
        env.id,
        `%${opts.search.replace(/[\\%_]/g, '\\$&')}%`,
        `%${opts.search.replace(/[\\%_]/g, '\\$&')}%`,
        limit,
      )
    : ctx.store.all<AppUser>('SELECT * FROM app_users WHERE env_id = ? ORDER BY last_seen DESC LIMIT ?', env.id, limit);
  return rows.map((u) => view(ctx, u));
}

export function signOutUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView & { revoked: number } {
  const u = userById(ctx, env, userId);
  const revoked = revokeSessions(ctx, u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.signout', { user: u.id, email: u.email, revoked });
  return { ...view(ctx, u), revoked };
}

export function blockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView {
  const u = userById(ctx, env, userId);
  ctx.store.run('UPDATE app_users SET blocked = 1 WHERE id = ?', u.id);
  revokeSessions(ctx, u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.block', { user: u.id, email: u.email });
  return view(ctx, userById(ctx, env, userId));
}

export function unblockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string, actor = 'console'): UserView {
  const u = userById(ctx, env, userId);
  ctx.store.run('UPDATE app_users SET blocked = 0 WHERE id = ?', u.id);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.user.unblock', { user: u.id, email: u.email });
  return view(ctx, userById(ctx, env, userId));
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheets run cells starting with these as formulas; names come from end users.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportUsersCsv(ctx: Ctx, app: AppRow, env: EnvRow): string {
  const cols = ['id', 'email', 'name', 'provider', 'first_seen', 'last_seen', 'blocked'] as const;
  const rows = listUsers(ctx, app, env, { limit: 10_000 }).map((u) => cols.map((c) => csvCell(u[c])).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

/** A signed-in session for a `test` user, so an agent can exercise login-only pages with curl. */
export async function createTestSession(ctx: Ctx, app: AppRow, env: EnvRow, email: string, actor: string): Promise<{ cookie: string; cookie_name: string; expires_in: string; expires_at: string; user: UserView }> {
  if (!ctx.resources.currentSpec(env)?.auth) throw fail('conflict', `sign-in is not enabled for ${app.name}/${env.name}`, 'add [auth] to boxlite.toml, then `boxlite-app apply` or `deploy`');
  const normal = email.trim().toLowerCase();
  const user = upsertUser(ctx, app, env, 'test', { id: normal, email: normal, name: normal.split('@')[0] ?? normal, avatarUrl: null });
  if (user.blocked) throw fail('forbidden', `${normal} is blocked in ${env.name}`, 'unblock it with `boxlite-app app auth users unblock <email>`');
  const { token, expiresAt } = createSession(ctx, user, 'test', TEST_SESSION_TTL_S);
  await mirrorUser(ctx, env.id, user);
  ctx.store.recordActivity(app.id, env.name, actor, 'auth.test_session', { user: user.id, email: normal });
  // For the app's own origin (BOXLITE_APP_URL); host-only there, like a real sign-in.
  const name = sessionName(ctx, app, env);
  return { cookie: `${name}=${token}`, cookie_name: name, expires_in: '15m', expires_at: expiresAt, user: view(ctx, user) };
}
