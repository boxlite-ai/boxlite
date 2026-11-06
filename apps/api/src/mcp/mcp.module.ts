/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { Module } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { AuthModule } from '../auth/auth.module'
import { OrganizationModule } from '../organization/organization.module'
import { McpAuthMetadata } from './mcp-auth'
import { McpController, McpMetadataController } from './mcp.controller'
import { createMcpServer, MCP_OPENAPI, McpServer } from './mcp-server'
import { McpRest } from './mcp-rest'

@Module({
  imports: [AuthModule, OrganizationModule],
  controllers: [McpController, McpMetadataController],
  providers: [
    McpAuthMetadata,
    McpRest,
    { provide: MCP_OPENAPI, useFactory: () => parse(readFileSync(join(__dirname, 'assets/box.openapi.yaml'), 'utf8')) },
    { provide: McpServer, inject: [MCP_OPENAPI, McpRest], useFactory: createMcpServer },
  ],
})
export class McpModule {}
