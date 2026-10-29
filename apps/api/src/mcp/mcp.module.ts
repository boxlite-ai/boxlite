/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { UserModule } from '../user/user.module'
import { McpAuthorizationService } from './mcp-authorization.service'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { McpController } from './mcp.controller'
import { McpMetadataController } from './mcp-metadata.controller'
import { McpServerFactory } from './mcp-server.factory'
import { BoxliteRestModule } from '../boxlite-rest/boxlite-rest.module'
import { EncryptionModule } from '../encryption/encryption.module'
import { AuditModule } from '../audit/audit.module'
import { McpOperationStore } from './mcp-operation.store'
import { McpOutputStore } from './mcp-output.store'
import { McpRunnerClient } from './mcp-runner.client'
import { McpOperationsService } from './mcp-operations.service'
import { McpOperationWorker } from './mcp-operation.worker'
import { McpOrganizationSubscriber } from './mcp-organization.subscriber'
import { McpGrantStore } from './mcp-grant.store'
import { McpConsentService } from './mcp-consent.service'
import { McpConsentController } from './mcp-consent.controller'

@Module({
  imports: [
    AuthModule,
    ApiKeyModule,
    UserModule,
    BoxModule,
    OrganizationModule,
    BoxliteRestModule,
    EncryptionModule,
    AuditModule,
  ],
  controllers: [McpController, McpMetadataController, McpConsentController],
  providers: [
    McpServerFactory,
    McpAuthMetadata,
    McpAuthorizationService,
    McpOperationStore,
    McpOutputStore,
    McpRunnerClient,
    McpOperationsService,
    McpOperationWorker,
    McpOrganizationSubscriber,
    McpGrantStore,
    McpConsentService,
  ],
})
export class McpModule {}
