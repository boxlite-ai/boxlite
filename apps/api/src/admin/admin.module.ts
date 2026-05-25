/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminSandboxController } from './controllers/sandbox.controller'
import { AdminOverviewController } from './controllers/overview.controller'
import { AdminTelemetryController } from './controllers/telemetry.controller'
import { AdminOverviewService } from './services/overview.service'
import { SandboxModule } from '../sandbox/sandbox.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'
import { UserModule } from '../user/user.module'
import { SandboxTelemetryModule } from '../sandbox-telemetry/sandbox-telemetry.module'

@Module({
  imports: [SandboxModule, RegionModule, OrganizationModule, UserModule, SandboxTelemetryModule],
  controllers: [AdminRunnerController, AdminSandboxController, AdminOverviewController, AdminTelemetryController],
  providers: [AdminOverviewService],
})
export class AdminModule {}
