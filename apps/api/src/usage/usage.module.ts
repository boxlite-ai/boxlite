/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxModule } from '../box/box.module'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationModule } from '../organization/organization.module'
import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageController } from './usage.controller'
import { UsageService } from './services/usage.service'
import { UsageMeteringService } from './usage-metering.service'
import { Region } from '../region/entities/region.entity'

@Module({
  imports: [BoxModule, OrganizationModule, TypeOrmModule.forFeature([UsagePeriod, UsagePeriodArchive, Region])],
  controllers: [UsageController],
  providers: [UsageService, UsageMeteringService, OrganizationActionGuard],
  exports: [UsageService],
})
export class UsageModule {}
