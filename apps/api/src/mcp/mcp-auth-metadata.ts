/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { getOAuthProtectedResourceMetadataUrl, type OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server'
import { JwtStrategy } from '../auth/jwt.strategy'
import { TypedConfigService } from '../config/typed-config.service'

/** Where this API serves MCP: the `mcp` controller under the `api` global prefix. */
const MCP_ROUTE = '/api/mcp'

/**
 * The RFC 9728 metadata route for {@link MCP_ROUTE}. The well-known prefix goes
 * before the whole route path, so the route sits outside the `api` prefix and
 * `main.ts` excludes it.
 */
export const MCP_METADATA_PATH = `.well-known/oauth-protected-resource${MCP_ROUTE}`

/**
 * OAuth discovery for the MCP endpoint.
 *
 * `MCP_RESOURCE_URL` is the public URL hosts connect to, so it is the resource
 * the metadata names. Without it the endpoint still takes bearer tokens but
 * publishes no metadata.
 */
@Injectable()
export class McpAuthMetadata {
  private readonly resource?: URL
  /** The metadata URL that 401 challenges advertise, once a resource URL is set. */
  readonly url?: string

  constructor(
    configService: TypedConfigService,
    private readonly jwtStrategy: JwtStrategy,
  ) {
    const resourceUrl = configService.get('mcp.resourceUrl')
    if (resourceUrl) {
      this.resource = parseResourceUrl(resourceUrl)
      this.url = getOAuthProtectedResourceMetadataUrl(this.resource)
    }
  }

  /** The audience MCP tokens must name: the resource itself (RFC 8707), once a resource URL is set. */
  get audience(): string | undefined {
    return this.resource?.href
  }

  /** The Protected Resource Metadata document. */
  document(): OAuthProtectedResourceMetadata {
    if (!this.resource) {
      throw new NotFoundException()
    }
    // The issuer the JWT strategy checks `iss` against is the one the
    // authorization server's own metadata reports, so a host's issuer check holds.
    return { resource: this.resource.href, authorization_servers: [this.jwtStrategy.issuer] }
  }
}

function parseResourceUrl(value: string): URL {
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== MCP_ROUTE || url.search || url.hash) {
    throw new Error(`MCP_RESOURCE_URL must be the http(s) URL of ${MCP_ROUTE}, without query or fragment`)
  }
  return url
}
