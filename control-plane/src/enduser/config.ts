/** End-user sign-in settings: TTLs, cookie names and paths, provider lookup, the OAuth callback URL and JWT issuer. */
import type { AppRow, EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { hostCookieName, isSecureUrl } from '../http/cookies.js';
import { OAUTH_PROVIDERS } from '../oauth-providers.js';
import { senderOf } from './email-sender.js';

export const STATE_TTL_S = 10 * 60;
/** Idle timeout: each use pushes `expires_at` this far out. */
export const SESSION_TTL_S = 7 * 24 * 3600;
/** Absolute cookie lifetime; past it the browser drops the cookie and the user signs in again. */
export const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
export const TEST_SESSION_TTL_S = 15 * 60;
export const IDENTITY_TTL_S = 5 * 60;
/** The callback → app origin handoff code: single use, stored hashed. */
export const HANDOFF_TTL_S = 60;
/** Per call to a sign-in provider (token exchange, profile): a stalled provider must not hold the callback. */
export const OAUTH_TIMEOUT_MS = 10_000;

/** `f` with a deadline on every call (the caller's own signal, if any, still applies). */
export function withTimeout(f: typeof fetch, ms: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    return f(input, { ...init, signal });
  }) as typeof fetch;
}
export const SLIDE_EVERY_MS = 60_000;

/** Each app env has its own origin, so one plain, host-only name is enough. */
export const SESSION_COOKIE_NAME = 'bxl_session';
/** On the API origin; one per env so two sign-ins in one browser do not clobber each other. */
export const verifierCookieName = (envId: string) => `bxl_pkce_${envId}`;
/**
 * On the app origin, set by /.boxlite/auth/login: binds the handoff code to the browser that began
 * the sign-in, so nobody can push their own code into someone else's browser (login CSRF).
 */
const LOGIN_NONCE_COOKIE = 'bxl_login';
export const sessionName = (ctx: Ctx, app: AppRow, env: EnvRow) => hostCookieName(SESSION_COOKIE_NAME, appSecure(ctx, app, env));
export const loginNonceName = (secure: boolean) => hostCookieName(LOGIN_NONCE_COOKIE, secure);
export const AUTH_PATH = '/auth/';
const CALLBACK_PATH = '/auth/callback/';

/** Providers BoxLite runs its own OAuth app for (the "BoxLite-managed keys"). */
export function configuredProviders(ctx: Pick<Ctx, 'config'>): string[] {
  return Object.keys(OAUTH_PROVIDERS).filter((n) => !OAUTH_PROVIDERS[n]!.ownKeysOnly && ctx.config.oauth?.[n]);
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** The App's own OAuth app (set in the console), not BoxLite's. */
  own: boolean;
}

/** The OAuth client an App's end-user sign-in uses for `provider`: the App's own, else BoxLite's. */
export function oauthClientFor(ctx: Pick<Ctx, 'store' | 'config'>, app: AppRow, provider: string): OAuthClient | undefined {
  const p = OAUTH_PROVIDERS[provider];
  if (!p) return undefined;
  const own = ctx.store.get<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM app_oauth_clients WHERE app_id = ? AND provider = ?', app.id, provider);
  if (own) return { clientId: own.client_id, clientSecret: own.client_secret, own: true };
  const shared = p.ownKeysOnly ? undefined : ctx.config.oauth?.[provider];
  return shared ? { ...shared, own: false } : undefined;
}

/** Providers an App's sign-in can use: its own OAuth apps plus BoxLite's, and `email` once it has a sender. */
export function appProviders(ctx: Pick<Ctx, 'store' | 'config'>, app: AppRow): string[] {
  const oauth = Object.keys(OAUTH_PROVIDERS).filter((p) => oauthClientFor(ctx, app, p));
  return senderOf(ctx, app) ? [...oauth, 'email'] : oauth;
}

/**
 * The OAuth app's registered callback is one fixed URL on the API origin, not one per app:
 * providers only accept pre-registered redirect URIs, and apps come and go. The `state` says which
 * app env the sign-in belongs to.
 */
export const redirectUri = (ctx: Pick<Ctx, 'config'>, provider: string) => `${ctx.config.publicUrl}${CALLBACK_PATH}${provider}`;

/** `iss` of the identity JWT. */
export const identityIssuer = (ctx: Pick<Ctx, 'config'>) => `${ctx.config.publicUrl}/auth`;

export const apiSecure = (ctx: Pick<Ctx, 'config'>) => isSecureUrl(ctx.config.publicUrl);
export const appSecure = (ctx: Ctx, app: AppRow, env: EnvRow) => isSecureUrl(ctx.resources.appUrl(app.name, env.name));
