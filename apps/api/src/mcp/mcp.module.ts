/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { MCP_STRATEGY } from '@rekog/mcp-nest'
import { AuthModule } from '../auth/auth.module'
import { BoxliteRestModule } from '../boxlite-rest/boxlite-rest.module'
import { OrganizationModule } from '../organization/organization.module'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { McpController, mcpStrategy } from './mcp.controller'
import { McpDispatcher } from './mcp-dispatcher'
import { McpMetadataController } from './mcp-metadata.controller'
import { McpScopeGuard } from './mcp-scope.guard'
import { McpTools } from './mcp-tools'

@Module({
  imports: [AuthModule, BoxliteRestModule, DiscoveryModule, OrganizationModule],
  controllers: [McpController, McpMetadataController],
  providers: [
    { provide: MCP_STRATEGY, useValue: mcpStrategy },
    McpAuthGuard,
    McpAuthMetadata,
    McpDispatcher,
    McpScopeGuard,
    McpTools,
  ],
  exports: [McpTools],
})
export class McpModule {}
