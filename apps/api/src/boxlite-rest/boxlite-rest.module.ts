/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { HttpModule } from '@nestjs/axios'
import { BoxModule } from '../box/box.module'
import { AuthModule } from '../auth/auth.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { OrganizationModule } from '../organization/organization.module'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { CommerceBoxLimitService } from './services/commerce-box-limit.service'
import { RestBoxCreationService } from './services/rest-box-creation.service'
import { BoxAdmissionReservationService } from './services/box-admission-reservation.service'

@Module({
  imports: [HttpModule, BoxModule, AuthModule, ApiKeyModule, OrganizationModule],
  controllers: [
    BoxliteMeController,
    BoxliteConfigController,
    BoxliteBoxController,
    BoxliteProxyController,
    BoxliteVolumeController,
  ],
  providers: [
    BoxliteWsProxyService,
    BoxAutoResumeService,
    CommerceBoxLimitService,
    BoxAdmissionReservationService,
    RestBoxCreationService,
  ],
  exports: [BoxliteWsProxyService],
})
export class BoxliteRestModule {}
