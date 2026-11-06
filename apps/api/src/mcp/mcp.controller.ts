/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { McpHttpControllerFor, McpStrategy, StreamableHttpTransport } from '@rekog/mcp-nest'
import type { Request, Response } from 'express'
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter'
import { MCP_ROUTE } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpBodyGuard } from './mcp-body'
import { McpScopeGuard } from './mcp-scope.guard'
import { McpOriginGuard } from './origin.guard'

/**
 * Streamable HTTP for both protocol eras: the 2025 `initialize` handshake,
 * served statelessly, and the session-less 2026-07-28 revision. Each POST is
 * answered with one JSON body, never an SSE stream.
 */
export const mcpTransport = new StreamableHttpTransport({ protocol: 'dual', responseMode: 'json' })

/** The MCP server. `main.ts` starts it before the API listens; `McpTools` registers its tools. */
export const mcpStrategy = new McpStrategy({
  name: 'boxlite',
  version: '1.0.0',
  transports: [mcpTransport],
  logging: false,
})

/**
 * `/mcp`. The guards admit a user API key or an MCP-audience OAuth token and
 * set `req.user`, which each tool call runs its REST route as; a 401 carries the
 * bearer challenge naming the OAuth discovery metadata. Only then does
 * `McpBodyGuard` read the body, and `McpScopeGuard` hold OAuth callers to their
 * allowlist and scopes.
 */
@ApiExcludeController()
@Controller(MCP_ROUTE)
@UseGuards(McpOriginGuard, McpAuthGuard, McpBodyGuard, McpScopeGuard)
@UseFilters(McpAuthChallengeFilter)
export class McpController extends McpHttpControllerFor(mcpTransport) {
  @Post()
  override post(@Req() req: Request, @Res() res: Response): Promise<void> | void {
    // `subscriptions/listen` would hold a long-lived SSE stream open (#2028); this
    // endpoint answers every POST with one JSON body.
    if ((req.body as { method?: unknown } | undefined)?.method === 'subscriptions/listen') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: (req.body as { id?: unknown }).id ?? null,
        error: { code: -32601, message: 'subscriptions/listen is not supported by this endpoint' },
      })
      return
    }
    return super.post(req, res)
  }
}
