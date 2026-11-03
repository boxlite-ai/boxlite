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
import { AuditModule } from '../audit/audit.module'
import { McpToolAccess } from './mcp-tool-access'
import { McpToolAudit } from './mcp-tool-audit'
import { VolumeTools } from './volume-tools'
import { ImageTools } from './image-tools'
import { ImageModule } from '../image/image.module'

@Module({
  imports: [AuthModule, BoxModule, OrganizationModule, AuditModule, ImageModule],
  controllers: [McpController, McpMetadataController],
  providers: [McpServerFactory, McpAuthMetadata, McpToolAccess, McpToolAudit, VolumeTools, ImageTools],
})
export class McpModule {}
