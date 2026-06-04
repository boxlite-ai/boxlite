/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { crc32 } from 'node:zlib'
import { createHash } from 'crypto'
import { extractKeyDisplayPrefix, generateApiKeyHash, generateApiKeyValue } from './api-key'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// Independent base62(uint32) — deliberately NOT the production helper, so the
// checksum assertion crosses a real boundary instead of being tautological.
function base62Uint32(n: number): string {
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

describe('api-key', () => {
  describe('generateApiKeyValue', () => {
    it('produces {prefix}_{class}_{base62 body}{crc6} for each class', () => {
      for (const cls of ['live', 'test', 'svc'] as const) {
        expect(generateApiKeyValue('blk', cls)).toMatch(new RegExp(`^blk_${cls}_[0-9A-Za-z]{40,}$`))
      }
    })

    it('honors an overridden brand prefix', () => {
      expect(generateApiKeyValue('acme', 'live').startsWith('acme_live_')).toBe(true)
    })

    it('rejects an invalid prefix at the boundary', () => {
      expect(() => generateApiKeyValue('Blk', 'live')).toThrow(/Invalid API key prefix/)
      expect(() => generateApiKeyValue('b', 'live')).toThrow(/Invalid API key prefix/)
      expect(() => generateApiKeyValue('has_underscore', 'live')).toThrow(/Invalid API key prefix/)
      expect(() => generateApiKeyValue('toolongprefixvalue', 'live')).toThrow(/Invalid API key prefix/)
    })

    it('appends a CRC32 a secret scanner can verify offline', () => {
      const key = generateApiKeyValue('blk', 'live')
      const rest = key.slice('blk_live_'.length)
      const body = rest.slice(0, -6)
      const checksum = rest.slice(-6)
      expect(checksum).toBe(base62Uint32(crc32(Buffer.from(body)) >>> 0).padStart(6, '0'))
    })

    it('is unique per call (256-bit body entropy)', () => {
      expect(generateApiKeyValue('blk', 'live')).not.toBe(generateApiKeyValue('blk', 'live'))
    })
  })

  describe('extractKeyDisplayPrefix', () => {
    it('returns the {prefix}_{class}_ head for current keys', () => {
      expect(extractKeyDisplayPrefix(generateApiKeyValue('blk', 'live'))).toBe('blk_live_')
      expect(extractKeyDisplayPrefix(generateApiKeyValue('acme', 'svc'))).toBe('acme_svc_')
    })

    it('falls back to the first 3 chars for legacy Daytona values (display unchanged)', () => {
      expect(extractKeyDisplayPrefix('dtn_0000000000000000000000000000000000000000000000000000000000000000')).toBe(
        'dtn',
      )
      expect(extractKeyDisplayPrefix('abcdef')).toBe('abc')
    })
  })

  describe('generateApiKeyHash', () => {
    // Auth resolves keys by SHA-256 of the whole value. Pinning the digest of
    // a fixed legacy-format key makes any hashing change that would silently
    // invalidate every already-issued key fail loudly here.
    it('hashes a legacy dtn_ value to its known SHA-256 (proves zero auth break)', () => {
      const legacy = 'dtn_0000000000000000000000000000000000000000000000000000000000000000'
      expect(generateApiKeyHash(legacy)).toBe('f5d6c9e2d6502b5e547419370d8b0cdddf8659241fc6c15eb2ca78fc3430c84c')
      expect(generateApiKeyHash(legacy)).toBe(createHash('sha256').update(legacy).digest('hex'))
    })
  })
})
