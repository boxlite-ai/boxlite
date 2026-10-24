/** HMAC-signed values with a domain tag per use: the MAC, and the `<subject>.<expiry>.<mac>` format. */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../auth.js';

/**
 * HMAC-signed values (code health M19): the MAC behind every signed cookie or token, with a domain
 * tag so a value signed for one use never verifies for another. Users: the app access cookie
 * (`app-access`, proxy/gate.ts), the console session (`console-session`, console-auth.ts) and the
 * OAuth state (`oauth-state`, enduser/state.ts).
 */

/** HMAC-SHA256 of `<domain>:<body>`, base64url. */
export const signedMac = (secret: string, domain: string, body: string) => createHmac('sha256', secret).update(`${domain}:${body}`).digest('base64url');

export const verifyMac = (secret: string, domain: string, body: string, mac: string) => safeEqual(mac, signedMac(secret, domain, body));

/**
 * `<subject>.<expiry>.<mac>`, where the MAC covers `<subject><sep><expiry>`. The separator is part
 * of each existing format (`.` for app access, `:` for the console session) and cannot change
 * without signing everyone out.
 */
export function signExpiring(secret: string, domain: string, subject: string, ttlSeconds: number, sep: '.' | ':'): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${subject}.${exp}.${signedMac(secret, domain, `${subject}${sep}${exp}`)}`;
}

/** The subject of a value made by signExpiring, or null when it is malformed, expired or not signed by `secret` for `domain`. */
export function verifyExpiring(secret: string, domain: string, value: string | undefined, sep: '.' | ':'): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [subject, expText, mac] = parts as [string, string, string];
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp < Date.now() / 1000) return null;
  return verifyMac(secret, domain, `${subject}${sep}${exp}`, mac) ? subject : null;
}
