/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'node:crypto'
import { backofficeInternalConfig } from './configuration'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')

describe('backoffice internal config', () => {
  it('is disabled by default without requiring credential digests', () => {
    expect(backofficeInternalConfig({})).toEqual({
      enabled: false,
      readTokenDigests: {
        current: undefined,
        next: undefined,
      },
    })
  })

  it('fails closed when enabled without a current read-token digest', () => {
    expect(() =>
      backofficeInternalConfig({
        BACKOFFICE_INTERNAL_API_ENABLED: 'true',
      }),
    ).toThrow('BACKOFFICE_READ_TOKEN_DIGEST_CURRENT is required when BACKOFFICE_INTERNAL_API_ENABLED is true')
  })

  it('accepts a bounded current/next digest overlap and normalizes hex case', () => {
    const current = digest('synthetic-current-workload-token')
    const next = digest('synthetic-next-workload-token').toUpperCase()

    expect(
      backofficeInternalConfig({
        BACKOFFICE_INTERNAL_API_ENABLED: 'true',
        BACKOFFICE_READ_TOKEN_DIGEST_CURRENT: current,
        BACKOFFICE_READ_TOKEN_DIGEST_NEXT: next,
      }),
    ).toEqual({
      enabled: true,
      readTokenDigests: {
        current,
        next: next.toLowerCase(),
      },
    })
  })

  it('rejects malformed digests without echoing their value', () => {
    const malformed = 'not-a-sha256-digest'

    expect(() =>
      backofficeInternalConfig({
        BACKOFFICE_READ_TOKEN_DIGEST_CURRENT: malformed,
      }),
    ).toThrow('BACKOFFICE_READ_TOKEN_DIGEST_CURRENT must be a SHA-256 hex digest')

    try {
      backofficeInternalConfig({ BACKOFFICE_READ_TOKEN_DIGEST_CURRENT: malformed })
    } catch (error) {
      expect(String(error)).not.toContain(malformed)
    }
  })
})
