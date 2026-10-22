/** Platform cookies on every origin (code health M18): the `__Host-` naming rule, Set-Cookie attributes, reading a request cookie. Signed values: signed-token.ts. */

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
