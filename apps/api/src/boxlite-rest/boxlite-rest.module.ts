/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { CiWebhookController } from '../ci/ci-webhook.controller'
import { CiWebhookService } from '../ci/ci-webhook.service'
import { CiConnectController } from '../ci/ci-connect.controller'
import { CiSettingsController } from '../ci/ci-settings.controller'
import { CiManagementController } from '../ci/ci-management.controller'
import { CiSettingsService } from '../ci/ci-settings.service'
import { CiConnectService } from '../ci/ci-connect.service'
import { CiListenerService } from '../ci/ci-listener.service'
import { CiNativeState } from '../ci/ci-native-state'
import { CiNativeHost } from '../ci/ci-native-host'
import { CiNativeWorkers } from '../ci/ci-native-workers'
import { CiGitHubService } from '../ci/ci-github.service'
import { CiSecretsService } from '../ci/ci-secrets.service'
import { BoxModule } from '../box/box.module'
import { AuthModule } from '../auth/auth.module'
import { ApiKeyModule } from '../api-key/api-key.module'
import { OrganizationModule } from '../organization/organization.module'
import { UserModule } from '../user/user.module'
import { BoxliteMeController } from './boxlite-me.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { BoxliteImageController } from './boxlite-image.controller'
import { ImageModule } from '../image/image.module'
import { BoxliteRegistryController } from './boxlite-registry.controller'
import { RegistryModule } from '../registry/registry.module'
import { BoxliteMemberController } from './boxlite-member.controller'
import { BoxliteInvitationController } from './boxlite-invitation.controller'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { AuditModule } from '../audit/audit.module'
import { BoxliteCheckpointController } from './boxlite-checkpoint.controller'

@Module({
  imports: [
    BoxModule,
    AuthModule,
    ApiKeyModule,
    OrganizationModule,
    UserModule,
    ImageModule,
    RegistryModule,
    AuditModule,
  ],
  controllers: [
    BoxliteCheckpointController,
    // Canonical domain paths must precede legacy /v1/:prefix resource routes.
    BoxliteDomainController,
    CiConnectController,
    CiSettingsController,
    CiManagementController,
    CiWebhookController,
    BoxliteMeController,
    BoxliteConfigController,
    BoxliteBoxController,
    BoxliteProxyController,
    BoxliteVolumeController,
    BoxliteRegistryController,
    BoxliteImageController,
    BoxliteMemberController,
    BoxliteInvitationController,
  ],
  providers: [
    BoxliteWsProxyService,
    CommerceBoxLimitService,
    CiConnectService,
    CiSettingsService,
    CiNativeState,
    CiNativeHost,
    CiNativeWorkers,
    CiListenerService,
    CiGitHubService,
    CiSecretsService,
    CiWebhookService,
  ],
  exports: [BoxliteWsProxyService, CommerceBoxLimitService],
})
export class BoxliteRestModule {}
