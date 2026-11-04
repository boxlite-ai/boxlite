/** The RS256 signing key (injected by the platform), the JWKS, and the per-env identity JWT sent to apps. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../ctx'
import { IDENTITY_TTL_S, identityIssuer } from './config'
import type { EndUserRole } from './role'
import type { AppUser } from './sessions'

interface SigningKey {
  kid: string
  key: KeyObject
  jwk: JsonWebKey
}

const keys = new Map<string, SigningKey>()

/** RS256 key pair, provided by platform configuration so all replicas verify the same identity tokens. */
function signingKey(ctx: Pick<Ctx, 'config'>): SigningKey {
  const pem = ctx.config.identityPrivateKey
  if (!pem) throw new Error('App identity signing key is not configured')
  const cached = keys.get(pem)
  if (cached) return cached
  const key = createPrivateKey(pem)
  const pub = createPublicKey(key).export({ format: 'jwk' })
  // RFC 7638 thumbprint as kid.
  const kid = createHash('sha256')
    .update(JSON.stringify({ e: pub.e, kty: pub.kty, n: pub.n }))
    .digest('base64url')
  const out = { kid, key, jwk: { kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid } }
  keys.set(pem, out)
  return out
}

export function jwks(ctx: Pick<Ctx, 'config'>): { keys: JsonWebKey[] } {
  return { keys: [signingKey(ctx).jwk] }
}

/**
 * RS256 identity JWT for one app env (security review F4): `aud` is that env's origin URL, which
 * the app has as BOXLITE_APP_URL, so a token captured by app A does not verify at app B.
 */
export async function identityToken(
  ctx: Pick<Ctx, 'config' | 'resources'>,
  user: AppUser,
  app: string,
  env: string,
  role: EndUserRole,
  nowMs = Date.now(),
): Promise<string> {
  const k = signingKey(ctx)
  const iat = Math.floor(nowMs / 1000)
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const input = `${enc({ alg: 'RS256', typ: 'JWT', kid: k.kid })}.${enc({
    iss: identityIssuer(ctx),
    aud: await ctx.resources.appUrl(app, env),
    sub: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    role,
    app,
    env,
    iat,
    exp: iat + IDENTITY_TTL_S,
  })}`
  return `${input}.${sign('sha256', Buffer.from(input), k.key).toString('base64url')}`
}

export const jwksResponse = (ctx: Pick<Ctx, 'config'>) =>
  Response.json(jwks(ctx), { headers: { 'cache-control': 'public, max-age=300' } })
