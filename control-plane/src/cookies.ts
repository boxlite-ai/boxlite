import { createHmac } from 'node:crypto';
import { safeEqual } from './auth.js';

/**
 * Platform cookies and signed values, for every origin (API, console, app envs). One place for
 * the cookie rules (code health M18/M19): names, attributes, parsing, and the HMAC behind each
 * signed cookie or token, with a domain tag so a value signed for one use never verifies for another.
 */

/** Is this origin https (then cookies carry `Secure` and the `__Host-` prefix)? */
export const isSecureUrl = (url: string) => url.startsWith('https:');

/**
 * On https origins platform cookies carry the `__Host-` prefix. Every app origin shares the
 * proxy's parent domain, so without it a sibling app could plant a `Domain=` cookie with the
 * same name (cookie tossing) and sign a visitor in as someone else; browsers refuse to set a
 * `__Host-` cookie that has a Domain, lacks Secure or has a Path other than /.
 */
export const hostCookieName = (base: string, secure: boolean) => (secure ? `__Host-${base}` : base);

/** A `Set-Cookie` value: host-only (no Domain), HttpOnly, SameSite=Lax; Secure when the origin that sets it is https. */
export function setCookieValue(secure: boolean, name: string, value: string, path: string, maxAge: number): string {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** One cookie of a request, as sent (platform values are base64url and need no decoding). */
export function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** HMAC-SHA256 of `<domain>:<body>`, base64url. */
export const signedMac = (secret: string, domain: string, body: string) => createHmac('sha256', secret).update(`${domain}:${body}`).digest('base64url');

export const verifyMac = (secret: string, domain: string, body: string, mac: string) => safeEqual(mac, signedMac(secret, domain, body));
