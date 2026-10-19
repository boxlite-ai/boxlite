/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import type { JwtStrategy } from '../auth/jwt.strategy'
import type { TypedConfigService } from '../config/typed-config.service'
import { McpAuthMetadata } from './mcp-auth-metadata'

const jwtStrategy = { issuer: 'https://issuer.test/' } as unknown as JwtStrategy

function withResourceUrl(resourceUrl?: string): McpAuthMetadata {
  const configService = { get: () => resourceUrl } as unknown as TypedConfigService
  return new McpAuthMetadata(configService, jwtStrategy)
}

describe('McpAuthMetadata', () => {
  it('publishes no metadata without a resource URL', () => {
    const metadata = withResourceUrl(undefined)

    expect(metadata.url).toBeUndefined()
    expect(() => metadata.document()).toThrow(NotFoundException)
  })

  it.each([
    ['another route', 'https://boxlite.test/mcp'],
    ['a query', 'https://boxlite.test/api/mcp?tenant=1'],
    ['a fragment', 'https://boxlite.test/api/mcp#top'],
    ['another scheme', 'ftp://boxlite.test/api/mcp'],
    ['no URL at all', 'boxlite.test/api/mcp'],
  ])('refuses a resource URL with %s at startup', (_case, resourceUrl) => {
    expect(() => withResourceUrl(resourceUrl)).toThrow('MCP_RESOURCE_URL must be the http(s) URL of /api/mcp')
  })
})
