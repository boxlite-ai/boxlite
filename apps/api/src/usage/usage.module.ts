/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageController } from './usage.controller'
import { UsageRunnerController } from './usage-runner.controller'
import { UsageService } from './usage.service'

@Module({
  imports: [TypeOrmModule.forFeature([UsagePeriod])],
  controllers: [UsageController, UsageRunnerController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
