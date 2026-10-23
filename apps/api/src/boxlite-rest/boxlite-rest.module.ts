/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Module, Type } from '@nestjs/common'
import { BoxliteCacheController } from './boxlite-cache.controller'
import { RegionModule } from '../region/region.module'
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
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { BoxliteBoxSnapshotController } from './boxlite-box-snapshot.controller'
import { BoxliteSnapshotController } from './boxlite-snapshot.controller'

/** The controller's routes again, mounted at its unprefixed path alone. */
function unprefixed<T extends Type>(controller: T, path: string): T {
  @Controller(path)
  class UnprefixedMount extends controller {}
  Object.defineProperty(UnprefixedMount, 'name', { value: `${controller.name}Unprefixed` })
  return UnprefixedMount
}

/**
 * An unprefixed /v1/<collection>/<name> also fits another collection's
 * v1/:prefix/<collection> route, and the first route registered wins: without
 * these, GET /v1/images/boxes answered with the box list. Registered ahead of
 * every controller, they give each unprefixed path to the collection it names;
 * a routing prefix is an organization id or `default`, never a collection.
 */
const unprefixedMounts = [
  unprefixed(BoxliteSnapshotController, 'v1/snapshots'),
  unprefixed(BoxliteBoxController, 'v1/boxes'),
  unprefixed(BoxliteBoxSnapshotController, 'v1/boxes'),
  unprefixed(BoxliteProxyController, 'v1/boxes'),
  unprefixed(BoxliteVolumeController, 'v1/volumes'),
  unprefixed(BoxliteCacheController, 'v1/caches'),
  unprefixed(BoxliteRegistryController, 'v1/images/registries'),
  unprefixed(BoxliteImageController, 'v1/images'),
]

@Module({
  imports: [
    RegionModule,
    BoxModule,
    AuthModule,
    ApiKeyModule,
    OrganizationModule,
    UserModule,
    ImageModule,
    RegistryModule,
  ],
  controllers: [
    BoxliteMeController,
    BoxliteConfigController,
    ...unprefixedMounts,
    BoxliteCacheController,
    BoxliteBoxController,
    BoxliteBoxSnapshotController,
    BoxliteSnapshotController,
    BoxliteProxyController,
    BoxliteVolumeController,
    BoxliteRegistryController,
    BoxliteImageController,
    BoxliteMemberController,
    BoxliteInvitationController,
  ],
  providers: [BoxliteWsProxyService, CommerceBoxLimitService],
  exports: [BoxliteWsProxyService],
})
export class BoxliteRestModule {}
