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
import { McpRateLimitGuard } from './mcp-rate-limit.guard'
import type { McpCaller } from './mcp-authorization.service'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter'
import { MCP_CALLER_KEY, McpServerFactory } from './mcp-server.factory'
import { McpOriginGuard } from './origin.guard'

const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed: no GET stream or persistent session' },
  id: null,
}

/**
 * Both protocol eras use per-request servers; no session grants authority.
 * The background worker, rather than an HTTP stream, owns command output.
 */
@ApiExcludeController()
@Controller('mcp')
@UseGuards(McpOriginGuard, McpAuthGuard, McpRateLimitGuard)
@UseFilters(McpAuthChallengeFilter)
export class McpController implements OnModuleDestroy {
  private readonly handler: McpHttpHandler
  private readonly serve: NodeMcpRequestHandler

  constructor(serverFactory: McpServerFactory) {
    this.handler = createMcpHandler(serverFactory.forRequest, { legacy: 'stateless', responseMode: 'json' })
    this.serve = toNodeHandler(this.handler)
  }

  @Post()
  async handle(@Req() req: Request & { user: McpCaller; auth?: AuthInfo }, @Res() res: Response): Promise<void> {
    // JSON mode does not disable the SDK's long-lived subscription streams.
    if (req.body?.method === 'subscriptions/listen') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: req.body.id ?? null,
        error: { code: -32601, message: 'Subscriptions are not supported' },
      })
      return
    }
    // The SDK verifies no token; it passes `req.auth` to the factory as `authInfo`.
    req.auth = {
      token: req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '',
      clientId: '',
      scopes: req.user.scopes,
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
