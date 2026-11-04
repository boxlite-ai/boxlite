/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'
import { McpAuthMetadata } from './auth/mcp-auth-metadata'
import { McpController } from './mcp.controller'
import { McpMetadataController } from './auth/mcp-metadata.controller'
import { McpServerFactory } from './mcp-server.factory'
import { AuditModule } from '../audit/audit.module'
import { McpToolAccess } from './tools/shared/mcp-tool-access'
import { McpToolAudit } from './tools/shared/mcp-tool-audit'
import { VolumeTools } from './tools/volume/volume-tools'
import { ImageTools } from './tools/image/image-tools'
import { ImageModule } from '../image/image.module'
import { RegistryModule } from '../registry/registry.module'
import { RegistryTools } from './tools/registry/registry-tools'
import { BoxTools } from './tools/box/box-tools'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { NetworkTools } from './tools/box/network-tools'
import { McpRunnerHttp } from './runner/runner-http'
import { McpRunnerWebSocket } from './runner/runner-websocket'
import { McpExecutionTools } from './tools/execution/execution-tools'
import { McpExecutionOutputTools } from './tools/execution/execution-output-tools'
import { McpFileTools } from './tools/files/file-tools'
import { McpMetricsTools } from './tools/metrics/metrics-tools'
import { OrganizationTools } from './tools/organization/organization-tools'

@Module({
  imports: [AuthModule, BoxModule, OrganizationModule, AuditModule, ImageModule, RegistryModule],
  controllers: [McpController, McpMetadataController],
  providers: [
    McpServerFactory,
    McpAuthMetadata,
    McpToolAccess,
    McpToolAudit,
    VolumeTools,
    ImageTools,
    RegistryTools,
    BoxTools,
    CommerceBoxLimitService,
    NetworkTools,
    McpRunnerHttp,
    McpRunnerWebSocket,
    McpExecutionTools,
    McpExecutionOutputTools,
    McpFileTools,
    McpMetricsTools,
    OrganizationTools,
  ],
})
export class McpModule {}
