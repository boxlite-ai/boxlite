/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { SandboxModule } from '../sandbox/sandbox.module'
import { AuthModule } from '../auth/auth.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { OrganizationModule } from '../organization/organization.module'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

@Module({
  imports: [SandboxModule, AuthModule, ApiKeyModule, OrganizationModule],
  controllers: [
    BoxliteMeController,
    BoxliteConfigController,
    BoxliteBoxController,
    BoxliteProxyController,
  ],
  providers: [BoxliteWsProxyService],
  exports: [BoxliteWsProxyService],
})
export class BoxliteRestModule {}
