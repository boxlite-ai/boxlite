/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { MeteringPolicy } from './metering-policy'
import { UsagePeriodWriter } from './usage-period-writer'

@Module({
  providers: [MeteringPolicy, UsagePeriodWriter],
  exports: [MeteringPolicy, UsagePeriodWriter],
})
export class UsageMeteringModule {}
