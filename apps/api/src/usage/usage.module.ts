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
import { UsageService } from './usage.service'

@Module({
  imports: [BoxModule, OrganizationModule, TypeOrmModule.forFeature([UsagePeriod, UsagePeriodArchive])],
  controllers: [UsageController],
  providers: [UsageService, OrganizationActionGuard],
  exports: [UsageService],
})
export class UsageModule {}
