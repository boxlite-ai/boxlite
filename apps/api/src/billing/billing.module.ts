/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BoxUsagePeriod } from '../usage/entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'

@Module({
  imports: [TypeOrmModule.forFeature([BoxUsagePeriod, BoxUsagePeriodArchive])],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
