/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { McpController } from './mcp.controller'
import { McpMetadataController } from './mcp-metadata.controller'
import { McpServerFactory } from './mcp-server.factory'

@Module({
  imports: [AuthModule, BoxModule, OrganizationModule],
  controllers: [McpController, McpMetadataController],
  providers: [McpServerFactory, McpAuthMetadata],
})
export class McpModule {}
