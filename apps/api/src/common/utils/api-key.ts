/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import * as crypto from 'crypto'
import { crc32 } from 'node:zlib'

/**
 * Key class segment. `live`/`test` = user dashboard keys (Stripe-style
 * environment split); `svc` = internal machine keys (runner / proxy /
 * ssh-gateway). Cosmetic — for humans, masked display, and secret scanners;
 * never consulted during authentication.
 */
export type ApiKeyClass = 'live' | 'test' | 'svc'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// The brand prefix is operator-overridable (self-host / white-label) and ends
// up in every issued key and in secret-scanner regexes, so it is validated at
// this boundary rather than trusted.
const PREFIX_RE = /^[a-z][a-z0-9]{1,15}$/

export function generateRandomString(size: number): string {
  return crypto.randomBytes(size).toString('hex')
}

function base62FromBytes(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'))
  if (n === 0n) {
    return '0'
  }
  let out = ''
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out
    n /= 62n
  }
  return out
}

function base62FromUint32(n: number): string {
  if (n === 0) {
    return '0'
  }
  let out = ''
  while (n > 0) {
    out = BASE62[n % 62] + out
    n = Math.floor(n / 62)
  }
  return out
}

/**
 * 6-char base62 CRC32 of the random body, appended to the key so secret
 * scanners can reject malformed / fabricated tokens offline without a DB
 * lookup (GitHub's token-format scheme). Purely a leak-detection aid —
 * authentication is still SHA-256 of the whole value. 62^6 > 2^32, so 6 chars
 * always hold a uint32 CRC.
 */
function checksum(body: string): string {
  const c = crc32(Buffer.from(body)) >>> 0
  return base62FromUint32(c).padStart(6, '0')
}

/**
 * Mint an opaque API key `{prefix}_{class}_{base62(256-bit)}{crc6}`
 * (e.g. `blk_live_<~43 base62><6>`). Structure aligns with
 * Stripe/GitHub/Doppler/AWS; the prefix and class carry no security — the
 * 256-bit body plus the server-side hash do.
 */
export function generateApiKeyValue(prefix: string, keyClass: ApiKeyClass): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(
      `Invalid API key prefix "${prefix}": must be lowercase alphanumeric, 2-16 chars, starting with a letter (check API_KEY_PREFIX)`,
    )
  }
  const body = base62FromBytes(crypto.randomBytes(32))
  return `${prefix}_${keyClass}_${body}${checksum(body)}`
}

/**
 * Hash an API key for at-rest storage / lookup.
 *
 * Uses SHA-256 (not a slow KDF like bcrypt/scrypt/argon2) deliberately:
 * API keys produced by {@link generateApiKeyValue} carry 256 bits of
 * CSPRNG entropy (`crypto.randomBytes(32)`) -- the keyspace is
 * computationally infeasible to brute-force regardless of hash speed.
 * Slow KDFs exist to defend *low-entropy human passwords*; they impose
 * latency on every auth request without adding security for random
 * high-entropy tokens. Matches the upstream `daytonaio/daytona`
 * implementation byte-for-byte and the documented pattern used by
 * Stripe, GitHub, Doppler, and other API-key providers.
 */
export function generateApiKeyHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Non-secret prefix used for masked display (`blk_live_••••abc`). Returns the
 * `{prefix}_{class}_` head for current keys; for legacy single-segment values
 * (Daytona `dtn_…`) falls back to the first 3 characters, matching the
 * pre-existing stored `keyPrefix` so already-issued rows render unchanged.
 */
export function extractKeyDisplayPrefix(value: string): string {
  const firstUnderscore = value.indexOf('_')
  if (firstUnderscore === -1) {
    return value.substring(0, 3)
  }
  const secondUnderscore = value.indexOf('_', firstUnderscore + 1)
  if (secondUnderscore === -1) {
    return value.substring(0, 3)
  }
  return value.substring(0, secondUnderscore + 1)
}
