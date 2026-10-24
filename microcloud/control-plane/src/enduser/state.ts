/** The signed OAuth `state` that carries a sign-in from the app origin to the provider and back. */
import { safeEqual } from '../auth.js';
import { signedMac } from '../http/signed-token.js';
import { STATE_TTL_S } from './config.js';

export interface OAuthState {
  app: string;
  env: string;
  next: string;
  provider: string;
  /** sha256 of the PKCE verifier, which waits in a cookie on the API origin's /auth/ path. */
  vh: string;
  /** sha256 of the app-origin login nonce (`bxl_login`), checked again by /.boxlite/auth/complete. */
  bh?: string;
  /** The verified custom domain the sign-in began on (services/domains.ts); the hand-off returns there. */
  host?: string;
  /** `console`: a console sign-in (console-signin.ts); `app` and `env` are empty then. */
  purpose?: 'console';
  exp: number;
}

const stateMac = (secret: string, body: string) => signedMac(secret, 'oauth-state', body);

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
