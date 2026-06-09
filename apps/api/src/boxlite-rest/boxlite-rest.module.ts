/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { SandboxModule } from '../sandbox/sandbox.module'
import { AuthModule } from '../auth/auth.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { OrganizationModule } from '../organization/organization.module'
import { Sandbox } from '../sandbox/entities/sandbox.entity'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteMetricsController } from './boxlite-metrics.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

@Module({
  imports: [SandboxModule, AuthModule, ApiKeyModule, OrganizationModule, TypeOrmModule.forFeature([Sandbox])],
  controllers: [
    BoxliteMeController,
    BoxliteConfigController,
    BoxliteBoxController,
    BoxliteProxyController,
    BoxliteMetricsController,
  ],
  providers: [BoxliteWsProxyService],
  exports: [BoxliteWsProxyService],
})
export class BoxliteRestModule {}
