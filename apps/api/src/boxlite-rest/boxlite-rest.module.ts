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
import { BoxliteAuthController } from './boxlite-auth.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'

@Module({
  imports: [SandboxModule, AuthModule, ApiKeyModule, OrganizationModule],
  controllers: [
    BoxliteAuthController,
    BoxliteConfigController,
    BoxliteBoxController,
    BoxliteProxyController,
  ],
})
export class BoxliteRestModule {}
