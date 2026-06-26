/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageController } from './usage.controller'
import { UsageRunnerController } from './usage-runner.controller'
import { UsageReconcileService } from './usage-reconcile.service'
import { UsageService } from './usage.service'

@Module({
  // Box + Runner are read-only here (reconcile reads box state + runner liveness).
  imports: [TypeOrmModule.forFeature([UsagePeriod, Box, Runner])],
  controllers: [UsageController, UsageRunnerController],
  providers: [UsageService, UsageReconcileService],
  exports: [UsageService],
})
export class UsageModule {}
