/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { McpAuthMetadata } from './mcp-auth-metadata'
import { MCP_OAUTH_SCOPES } from './mcp-oauth-policy'

function metadataFor(resourceUrl: string) {
  const config = { get: (key: string) => (key === 'mcp.resourceUrl' ? resourceUrl : undefined) }
  return new McpAuthMetadata(config as never, { issuer: 'https://issuer.example.test/' } as never)
}

describe('McpAuthMetadata', () => {
  it('advertises only the sign-in baseline scope, not every MCP scope', () => {
    const document = metadataFor('https://api.example.test/api/mcp').document()

    expect(document).toEqual({
      resource: 'https://api.example.test/api/mcp',
      authorization_servers: ['https://issuer.example.test/'],
      scopes_supported: ['write:boxes'],
    })
    expect(document.scopes_supported!.length).toBeLessThan(MCP_OAUTH_SCOPES.length)
  })
})
