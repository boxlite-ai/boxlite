import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppRow, EnvRow, Store } from './db.js';
import { fail } from './errors.js';

export type Vars = {
  app: AppRow;
  actor: string;
  env: EnvRow;
};

export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 32 base32 characters = 160 random bits. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const newAppKey = () => `bxl_app_${base32(randomBytes(20))}`;
export const newBoxToken = () => `bxt_${base32(randomBytes(20))}`;
export const newId = (prefix: string) => `${prefix}_${base32(randomBytes(10))}`;
export const newSecret = () => randomBytes(24).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** App key → its app, or undefined. Only the sha256 of a key is stored. */
export function appForKey(store: Store, key: string): { app: AppRow; last4: string } | undefined {
  const row = store.get<{ app_id: string; last4: string }>('SELECT app_id, last4 FROM keys WHERE hash = ? AND revoked_at IS NULL', sha256hex(key));
  if (!row) return undefined;
  const app = store.appById(row.app_id);
  return app ? { app, last4: row.last4 } : undefined;
}

export function requireAdmin(adminToken: string): MiddlewareHandler {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) throw fail('unauthenticated', 'missing admin token', 'send Authorization: Bearer <ADMIN_TOKEN>');
    if (!safeEqual(token, adminToken)) throw fail('unauthenticated', 'bad admin token');
    await next();
  };
}

/**
 * /v1/apps/:app/* — the App key identifies the App, so `:app` must match it (else 403).
 * The CP's admin token is accepted too, acting as `admin`.
 */
export function requireAppKey(store: Store, adminToken: string): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) throw fail('unauthenticated', 'missing App key', 'send Authorization: Bearer <App key> (bxl_app_…)');
    const name = c.req.param('app') ?? '';
    if (safeEqual(token, adminToken)) {
      const app = store.appByName(name);
      if (!app) throw fail('not_found_app', `no app named "${name}"`);
      c.set('app', app);
      // The console calls these routes in-process with the admin token; it names itself so Activity can tell the two apart.
      c.set('actor', c.req.header('x-boxlite-actor') === 'console' ? 'console' : 'admin');
      return next();
    }
    const found = appForKey(store, token);
    if (!found) throw fail('unauthenticated', 'App key not recognised', 'check BOXLITE_API_KEY against the App prompt (the key is shown once, when the App is created); `boxlite-app whoami` tests it');
    // `me` lets a CLI that only knows its key discover the app name.
    if (found.app.name !== name && name !== 'me') throw fail('forbidden', `this App key belongs to "${found.app.name}", not "${name}"`);
    c.set('app', found.app);
    c.set('actor', `key:…${found.last4}`);
    await next();
  };
}

/** /sv/v1/* — the box token (BOXLITE_BOX_TOKEN) identifies the env. */
export function requireBoxToken(store: Store): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) throw fail('unauthenticated', 'missing box token');
    const row = store.get<{ env_id: string }>('SELECT env_id FROM box_tokens WHERE hash = ? AND revoked_at IS NULL', sha256hex(token));
    const env = row ? store.envById(row.env_id) : undefined;
    const app = env ? store.appById(env.app_id) : undefined;
    if (!env || !app) throw fail('unauthenticated', 'box token not recognised');
    c.set('env', env);
    c.set('app', app);
    c.set('actor', 'supervisor');
    await next();
  };
}
