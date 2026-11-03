/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  OnModuleDestroy,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import type { Request, Response } from 'express'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { McpAuthChallengeFilter } from './auth/mcp-auth-challenge.filter'
import { McpAuthGuard } from './auth/mcp-auth.guard'
import { MCP_CALLER_KEY, McpServerFactory } from './mcp-server.factory'
import { McpOriginGuard } from './auth/origin.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'

const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed: this MCP endpoint has no GET stream or session' },
  id: null,
}

/**
 * Stateless Streamable HTTP endpoint for modern and legacy MCP clients.
 *
 * Modern requests use JSON replies; the SDK serves legacy initialize-handshake
 * traffic with request-scoped SSE replies without issuing a session ID.
 * Only OAuth bearer tokens issued for this endpoint are accepted, not API keys;
 * a 401 carries a bearer challenge naming the endpoint's OAuth discovery metadata.
 */
@ApiExcludeController()
@Controller('mcp')
@UseGuards(McpOriginGuard, McpAuthGuard, AuthenticatedRateLimitGuard)
@UseFilters(McpAuthChallengeFilter)
export class McpController implements OnModuleDestroy {
  private readonly handler: McpHttpHandler
  private readonly serve: NodeMcpRequestHandler

  constructor(serverFactory: McpServerFactory) {
    this.handler = createMcpHandler(serverFactory.forRequest, { legacy: 'stateless', responseMode: 'json' })
    this.serve = toNodeHandler(this.handler)
  }

  @Post()
  async handle(@Req() req: Request & { user: AuthContext; auth?: AuthInfo }, @Res() res: Response): Promise<void> {
    // The SDK verifies no token; it passes `req.auth` to the factory as `authInfo`.
    // The guard hands over the verified caller, not the token's claims, so the
    // client ID and scopes are not read from the token yet (TODO).
    req.auth = {
      token: req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '',
      clientId: '',
      scopes: [],
      extra: { [MCP_CALLER_KEY]: req.user },
    }
    // Nest has already parsed the body; hand it over so the stream is not read twice.
    await this.serve(req, res, req.body)
  }

  @Get()
  @HttpCode(405)
  openStream() {
    return METHOD_NOT_ALLOWED
  }

  @Delete()
  @HttpCode(405)
  endSession() {
    return METHOD_NOT_ALLOWED
  }

  async onModuleDestroy(): Promise<void> {
    await this.handler.close()
  }
}
