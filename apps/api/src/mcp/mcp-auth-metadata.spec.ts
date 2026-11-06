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
  it('advertises every MCP scope, so a client requests them all at sign-in', () => {
    const document = metadataFor('https://api.example.test/mcp').document()

    expect(document).toEqual({
      resource: 'https://api.example.test/mcp',
      authorization_servers: ['https://issuer.example.test/'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    })
    expect(document.scopes_supported).toContain('delete:boxes')
  })

  it('advertises its metadata at the well-known URI for /mcp', () => {
    expect(metadataFor('https://api.example.test/mcp').url).toBe(
      'https://api.example.test/.well-known/oauth-protected-resource/mcp',
    )
  })

  it('refuses a resource URL that is not /mcp', () => {
    expect(() => metadataFor('https://api.example.test/api/mcp')).toThrow('MCP_RESOURCE_URL')
  })
})
