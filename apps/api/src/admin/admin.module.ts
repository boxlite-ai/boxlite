/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { AdminObservabilityController } from './controllers/observability.controller'
import { AdminOverviewController } from './controllers/overview.controller'
import { AdminRunnerController } from './controllers/runner.controller'
import { AdminBoxController } from './controllers/box.controller'
import {
  ADMIN_AUDIT_LOG_READER,
  ADMIN_CLOUDWATCH_LOG_READER,
  ADMIN_PLATFORM_STATE_READER,
  ADMIN_S3_OBJECT_READER,
  AdminObservabilityService,
} from './services/observability.service'
import { AdminCloudWatchLogReader } from './services/observability-cloudwatch.reader'
import { AdminOverviewService } from './services/overview.service'
import { AdminS3ObjectReader } from './services/observability-s3.reader'
import { BoxModule } from '../box/box.module'
import { RegionModule } from '../region/region.module'
import { OrganizationModule } from '../organization/organization.module'
import { UserModule } from '../user/user.module'
import { AuditModule } from '../audit/audit.module'
import { AuditService } from '../audit/services/audit.service'

@Module({
  imports: [BoxModule, RegionModule, OrganizationModule, UserModule, AuditModule],
  controllers: [AdminRunnerController, AdminBoxController, AdminOverviewController, AdminObservabilityController],
  providers: [
    AdminOverviewService,
    AdminObservabilityService,
    AdminCloudWatchLogReader,
    AdminS3ObjectReader,
    { provide: ADMIN_PLATFORM_STATE_READER, useExisting: AdminOverviewService },
    { provide: ADMIN_AUDIT_LOG_READER, useExisting: AuditService },
    { provide: ADMIN_CLOUDWATCH_LOG_READER, useExisting: AdminCloudWatchLogReader },
    { provide: ADMIN_S3_OBJECT_READER, useExisting: AdminS3ObjectReader },
  ],
})
export class AdminModule {}
