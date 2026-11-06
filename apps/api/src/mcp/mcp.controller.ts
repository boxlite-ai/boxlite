/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { Controller, Delete, Get, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { MCP_METADATA_PATH, McpAccessGuard, McpAuthChallengeFilter, McpAuthMetadata } from './mcp-auth'
import { McpServer } from './mcp-server'

@ApiExcludeController()
@Controller('mcp')
@UseGuards(CombinedAuthGuard, McpAccessGuard, AuthenticatedRateLimitGuard)
@UseFilters(McpAuthChallengeFilter)
export class McpController {
  constructor(private readonly server: McpServer) {}

  @Post()
  async post(@Req() request: Request, @Res() response: Response): Promise<void> {
    // This prototype handles finite calls, with no cross-request sessions.
    if (request.body?.method === 'subscriptions/listen' || request.get('mcp-method') === 'subscriptions/listen') {
      response.status(400).json({
        jsonrpc: '2.0',
        id: request.body?.id ?? null,
        error: { code: -32601, message: 'Subscriptions are not supported' },
      })
      return
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => {
      void transport.close()
    })
    try {
      await this.server.connect(transport, { request })
      await transport.handleRequest(request, response, request.body)
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  @Get()
  get(@Req() request: Request, @Res() response: Response): void {
    response
      .status(405)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'No GET stream or persistent session' } })
  }

  @Delete()
  delete(@Req() request: Request, @Res() response: Response): void {
    this.get(request, response)
  }
}

@ApiExcludeController()
@Controller(MCP_METADATA_PATH)
export class McpMetadataController {
  constructor(private readonly metadata: McpAuthMetadata) {}

  @Get()
  get(@Res() response: Response) {
    const document = this.metadata.document()
    return response.status(document ? 200 : 404).json(document ?? { error: 'MCP OAuth is not configured' })
  }
}
