/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'
import { Region } from '../region/entities/region.entity'
import { UsageController } from './controllers/usage.controller'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { UsageQueryService } from './services/usage-query.service'
import { UsageService } from './services/usage.service'

@Module({
  imports: [BoxModule, OrganizationModule, TypeOrmModule.forFeature([BoxUsagePeriod, BoxUsagePeriodArchive, Region])],
  controllers: [UsageController],
  providers: [UsageService, UsageQueryService],
  exports: [UsageService],
})
export class UsageModule {}
