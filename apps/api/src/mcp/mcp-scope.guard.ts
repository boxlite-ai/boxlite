/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import type { Request, Response } from 'express'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { MCP_OAUTH_OPERATIONS, mcpOAuthScopes } from './mcp-oauth-policy'
import { McpTools } from './mcp-tools'

/** Tools that run no catalog operation. */
const CATALOG_READ_TOOLS = new Set(['list_api_endpoints', 'get_api_endpoint_schema'])

/**
 * The one scope check for OAuth callers, before any tool runs. An operation off
 * the OAuth allowlist is refused outright; one whose route needs a permission the
 * token lacks answers `403` with an `insufficient_scope` challenge naming the
 * granted scopes plus the missing ones, so a client that re-authorizes keeps what
 * it already had. API-key callers pass: their key's permissions apply in REST.
 */
@Injectable()
export class McpScopeGuard implements CanActivate {
  constructor(
    private readonly tools: McpTools,
    private readonly metadata: McpAuthMetadata,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const granted = mcpOAuthScopes(request)
    if (!granted) return true
    for (const operationId of calledOperations(request.body)) {
      if (!MCP_OAUTH_OPERATIONS.has(operationId)) {
        throw new ForbiddenException(`${operationId} needs an API key; OAuth tokens reach workload operations only`)
      }
      const missing = this.tools.requiredPermissions(operationId).filter((scope) => !granted.includes(scope))
      if (missing.length > 0) {
        const challenge = bearerAuthChallengeResponse(
          new OAuthError(OAuthErrorCode.InsufficientScope, `${operationId} needs ${missing.join(' ')}`),
          { requiredScopes: [...granted, ...missing], resourceMetadataUrl: this.metadata.url },
        ).headers.get('WWW-Authenticate')
        if (challenge) context.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', challenge)
        throw new ForbiddenException(`insufficient_scope: ${operationId} needs ${missing.join(' ')}`)
      }
    }
    return true
  }
}

/** The catalog operations the `tools/call` messages of a request body would run. */
export function calledOperations(body: unknown): string[] {
  const ids: string[] = []
  for (const message of [body].flat()) {
    const { method, params } = (message ?? {}) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
    if (method !== 'tools/call' || typeof params?.name !== 'string' || CATALOG_READ_TOOLS.has(params.name)) continue
    if (params.name === 'invoke_api_endpoint') {
      ids.push(String((params.arguments as { operationId?: unknown } | undefined)?.operationId))
    } else {
      ids.push(params.name)
    }
  }
  return ids
}
