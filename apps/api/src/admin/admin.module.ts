/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminBoxController } from './controllers/box.controller'
import { BoxModule } from '../box/box.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'
import { InfrastructureLogsController } from './controllers/infrastructure-logs.controller'
import { InfrastructureLogsService } from './services/infrastructure-logs.service'
import { PlatformLogsService } from './services/platform-logs.service'
import { BoxTelemetryModule } from '../box-telemetry/box-telemetry.module'

@Module({
  imports: [BoxModule, RegionModule, OrganizationModule, BoxTelemetryModule],
  controllers: [AdminRunnerController, AdminBoxController, InfrastructureLogsController],
  providers: [InfrastructureLogsService, PlatformLogsService],
})
export class AdminModule {}
