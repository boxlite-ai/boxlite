/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminBoxController } from './controllers/box.controller'
import { AdminProviderController } from './controllers/provider.controller'
import { AdminOrganizationOverviewService } from './services/organization-overview.service'
import { AdminPlatformOverviewService } from './services/platform-overview.service'
import { BoxModule } from '../box/box.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Region } from '../region/entities/region.entity'
import { Runner } from '../box/entities/runner.entity'
import { Box } from '../box/entities/box.entity'
import { Job } from '../box/entities/job.entity'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { User } from '../user/user.entity'
import { BoxUsagePeriod } from '../usage/entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'

@Module({
  imports: [
    BoxModule,
    RegionModule,
    OrganizationModule,
    TypeOrmModule.forFeature([
      Region,
      Runner,
      Box,
      Job,
      Organization,
      OrganizationUser,
      User,
      BoxUsagePeriod,
      BoxUsagePeriodArchive,
    ]),
  ],
  controllers: [AdminRunnerController, AdminBoxController, AdminProviderController],
  providers: [AdminOrganizationOverviewService, AdminPlatformOverviewService],
})
export class AdminModule {}
