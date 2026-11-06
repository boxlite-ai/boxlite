/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, type INestApplication, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { McpHttpControllerFor, McpStrategy, StreamableHttpTransport } from '@rekog/mcp-nest'
import { json, type NextFunction, type Request, type Response } from 'express'
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter'
import { MCP_ROUTE } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpScopeGuard } from './mcp-scope.guard'
import { McpOriginGuard } from './origin.guard'

/**
 * Streamable HTTP for both protocol eras: the 2025 `initialize` handshake,
 * served statelessly, and the session-less 2026-07-28 revision. Each POST is
 * answered with one JSON body, never an SSE stream.
 */
export const mcpTransport = new StreamableHttpTransport({ protocol: 'dual', responseMode: 'json' })

/**
 * JSON limit for `/api/mcp`: a tool call carries up to 8 MiB of binary as base64
 * (11,184,812 bytes) plus its JSON-RPC envelope. Other routes keep the default.
 */
export const MCP_JSON_LIMIT = '12mb'

/**
 * Parses `/api/mcp` bodies with {@link MCP_JSON_LIMIT}. Call before `app.init()`, so
 * it runs ahead of the global parser, which then skips the already-read body. The
 * wrapper keeps its own name: Nest registers no global JSON parser when a router
 * layer is already named `jsonParser`.
 */
export function useMcpBodyParser(app: INestApplication): void {
  const parse = json({ limit: MCP_JSON_LIMIT })
  app.use(MCP_ROUTE, function mcpJsonParser(req: Request, res: Response, next: NextFunction) {
    parse(req, res, next)
  })
}

/** The MCP server. `main.ts` starts it before the API listens; `McpTools` registers its tools. */
export const mcpStrategy = new McpStrategy({
  name: 'boxlite',
  version: '1.0.0',
  transports: [mcpTransport],
  logging: false,
})

/**
 * `/api/mcp`. The guards admit a user API key or an MCP-audience OAuth token and
 * set `req.user`, which each tool call runs its REST route as; a 401 carries the
 * bearer challenge naming the OAuth discovery metadata. `McpScopeGuard` then
 * holds OAuth callers to their allowlist and scopes.
 */
@ApiExcludeController()
@Controller('mcp')
@UseGuards(McpOriginGuard, McpAuthGuard, McpScopeGuard)
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
