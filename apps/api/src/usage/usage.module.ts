/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxModule } from '../box/box.module'
import { BoxAccessGuard } from '../box/guards/box-access.guard'
import { OrganizationModule } from '../organization/organization.module'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageController } from './usage.controller'
import { UsageService } from './usage.service'

@Module({
  // OrganizationModule + BoxModule satisfy the controller guards' constructor deps —
  // OrganizationResourceActionGuard needs OrganizationService, BoxAccessGuard needs
  // BoxService. Without them the API fails to boot (tsc + unit tests still pass), so
  // this is verified on the running stack, not just by compiling.
  imports: [TypeOrmModule.forFeature([UsagePeriod]), OrganizationModule, BoxModule],
  controllers: [UsageController],
  providers: [UsageService, BoxAccessGuard],
  exports: [UsageService],
})
export class UsageModule {}
