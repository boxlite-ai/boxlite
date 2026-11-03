/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server'
import { MCP_METADATA_PATH, McpAuthMetadata } from './mcp-auth-metadata'

/** Serves the MCP endpoint's Protected Resource Metadata (RFC 9728) without authentication. */
@ApiExcludeController()
@Controller(MCP_METADATA_PATH)
export class McpMetadataController {
  constructor(private readonly metadata: McpAuthMetadata) {}

  @Get()
  protectedResource(): OAuthProtectedResourceMetadata {
    return this.metadata.document()
  }
}
