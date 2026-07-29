/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { UsageService } from './services/usage.service'
import { Region } from '../region/entities/region.entity'
import { UsageMeteringModule } from './metering/usage-metering.module'

@Module({
  imports: [UsageMeteringModule, TypeOrmModule.forFeature([BoxUsagePeriod, BoxUsagePeriodArchive, Region])],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
