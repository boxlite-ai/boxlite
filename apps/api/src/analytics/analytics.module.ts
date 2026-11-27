/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AnalyticsService } from './services/analytics.service'

import { ConsoleAnalyticsController } from './console-analytics.controller'
import { AnalyticsConsentService } from './services/analytics-consent.service'

@Module({
  controllers: [ConsoleAnalyticsController],
  providers: [AnalyticsService, AnalyticsConsentService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
