import { principalStorage, type PlatformPrincipal } from './platform-principal'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { AppRow, EnvRow, Store } from './db'
import { fail } from './errors'

export type Vars = {
  app: AppRow
  actor: string
  env: EnvRow
}

export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** 32 base32 characters = 160 random bits. */
export function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export const newBoxToken = () => `bxt_${base32(randomBytes(20))}`
export const newId = (prefix: string) => `${prefix}_${base32(randomBytes(10))}`
export const newSecret = () => randomBytes(24).toString('base64url')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1]!.trim() : null
}

/** Management identities are authenticated once by Nest and inherited by internal requests. */
export function requireAdmin(): MiddlewareHandler {
  return async (_c, next) => {
    if (!principalStorage.getStore()) throw fail('unauthenticated', 'platform authentication required')
    await next()
  }
}
export function requireAppKey(store: Store): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const p =
      (c.env as { platformPrincipal?: PlatformPrincipal } | undefined)?.platformPrincipal ?? principalStorage.getStore()
    if (!p) throw fail('unauthenticated', 'platform authentication required')
    let app = p.appId ? await store.appById(p.appId) : undefined
    const name = c.req.param('app')
    if (name && name !== 'me') {
      const requested = (await store.appByName(name)) ?? (await store.appById(name))
      if (!requested || (p.appId && requested.id !== p.appId)) throw fail('not_found_app', 'App not found')
      app = requested
    }
    if (!app || app.org_id !== p.organizationId) throw fail('not_found_app', 'App not found')
    c.set('app', app)
    c.set('actor', p.actor)
    await next()
  }
}
/** /sv/v1/* — the box token (BOXLITE_BOX_TOKEN) identifies the env. */
export function requireBoxToken(store: Store): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'))
    if (!token) throw fail('unauthenticated', 'missing box token')
    const row = await store.get<{ env_id: string }>(
      'SELECT env_id FROM box_tokens WHERE hash = ? AND revoked_at IS NULL',
      sha256hex(token),
    )
    const env = row ? await store.envById(row.env_id) : undefined
    const app = env ? await store.appById(env.app_id) : undefined
    if (!env || !app) throw fail('unauthenticated', 'box token not recognised')
    c.set('env', env)
    c.set('app', app)
    c.set('actor', 'supervisor')
    await next()
  }
}
