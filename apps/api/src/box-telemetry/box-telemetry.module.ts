/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { BoxTelemetryController } from './controllers/box-telemetry.controller'
import { BoxTelemetryService } from './services/box-telemetry.service'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'

@Module({
  imports: [BoxModule, OrganizationModule],
  controllers: [BoxTelemetryController],
  providers: [BoxTelemetryService],
  exports: [BoxTelemetryService],
})
export class BoxTelemetryModule {}
