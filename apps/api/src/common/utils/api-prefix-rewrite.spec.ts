/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { parseUnprefixedApiHosts, rewriteUnprefixedApiUrlForHost } from './api-prefix-rewrite'

describe('api prefix rewrite', () => {
  const hosts = parseUnprefixedApiHosts('api.dev.boxlite.ai, api.boxlite.ai')

  it('prefixes API routes only on canonical API hosts', () => {
    expect(rewriteUnprefixedApiUrlForHost('api.dev.boxlite.ai', '/health', hosts)).toBe('/api/health')
    expect(rewriteUnprefixedApiUrlForHost('api.dev.boxlite.ai:443', '/v1/boxes?limit=10', hosts)).toBe(
      '/api/v1/boxes?limit=10',
    )
    expect(rewriteUnprefixedApiUrlForHost('dev.boxlite.ai', '/dashboard/boxes', hosts)).toBe('/dashboard/boxes')
  })

  it('preserves legacy prefixed API routes and static artifacts', () => {
    expect(rewriteUnprefixedApiUrlForHost('api.dev.boxlite.ai', '/api/health', hosts)).toBe('/api/health')
    expect(rewriteUnprefixedApiUrlForHost('api.dev.boxlite.ai', '/runner-amd64', hosts)).toBe('/runner-amd64')
    expect(rewriteUnprefixedApiUrlForHost('api.dev.boxlite.ai', '/assets/index.js', hosts)).toBe('/assets/index.js')
  })
})
