/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { BoxModule } from '../box/box.module'
import { OrganizationModule } from '../organization/organization.module'
import { TenantObservabilityController } from './controllers/tenant-observability.controller'
import { TenantTelemetryInterceptor } from './interceptors/tenant-telemetry.interceptor'
import { TenantObservabilityService } from './services/tenant-observability.service'

@Module({
  imports: [BoxModule, OrganizationModule],
  controllers: [TenantObservabilityController],
  providers: [TenantObservabilityService, TenantTelemetryInterceptor],
  exports: [TenantObservabilityService, TenantTelemetryInterceptor],
})
export class TenantObservabilityModule {}
