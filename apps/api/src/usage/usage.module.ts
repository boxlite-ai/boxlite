/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'
import { BoxModule } from '../box/box.module'
import { BoxAccessGuard } from '../box/guards/box-access.guard'
import { OrganizationModule } from '../organization/organization.module'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageController } from './usage.controller'
import { UsageRunnerController } from './usage-runner.controller'
import { UsageReconcileService } from './usage-reconcile.service'
import { UsageService } from './usage.service'

@Module({
  // Box + Runner are read-only here (reconcile reads box state + runner liveness).
  // OrganizationModule + BoxModule satisfy the controller guards' constructor deps —
  // without them the API fails to boot (OrganizationResourceActionGuard needs
  // OrganizationService; BoxAccessGuard needs BoxService). Caught only at runtime
  // boot (tsc + unit tests pass), verified on the infra-local stack.
  imports: [TypeOrmModule.forFeature([UsagePeriod, Box, Runner]), OrganizationModule, BoxModule],
  controllers: [UsageController, UsageRunnerController],
  providers: [UsageService, UsageReconcileService, BoxAccessGuard],
  exports: [UsageService],
})
export class UsageModule {}
