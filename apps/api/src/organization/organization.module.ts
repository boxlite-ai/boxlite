/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OrganizationController } from './controllers/organization.controller'
import { OrganizationRoleController } from './controllers/organization-role.controller'
import { OrganizationUserController } from './controllers/organization-user.controller'
import { OrganizationInvitationController } from './controllers/organization-invitation.controller'
import { Organization } from './entities/organization.entity'
import { OrganizationRole } from './entities/organization-role.entity'
import { OrganizationUser } from './entities/organization-user.entity'
import { OrganizationInvitation } from './entities/organization-invitation.entity'
import { OrganizationService } from './services/organization.service'
import { OrganizationRoleService } from './services/organization-role.service'
import { OrganizationUserService } from './services/organization-user.service'
import { OrganizationInvitationService } from './services/organization-invitation.service'
import { UserModule } from '../user/user.module'
import { Box } from '../box/entities/box.entity'
import { Volume } from '../box/entities/volume.entity'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { DataSource } from 'typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxLookupCacheInvalidationService } from '../box/services/box-lookup-cache-invalidation.service'
import { RegionModule } from '../region/region.module'
import { OrganizationRegionController } from './controllers/organization-region.controller'
import { Region } from '../region/entities/region.entity'
import { EncryptionModule } from '../encryption/encryption.module'

@Module({
  imports: [
    UserModule,
    RegionModule,
    TypeOrmModule.forFeature([
      Organization,
      OrganizationRole,
      OrganizationUser,
      OrganizationInvitation,
      Box,
      Volume,
      Region,
    ]),
    EncryptionModule,
  ],
  controllers: [
    OrganizationController,
    OrganizationRoleController,
    OrganizationUserController,
    OrganizationInvitationController,
    OrganizationRegionController,
  ],
  providers: [
    OrganizationService,
    OrganizationRoleService,
    OrganizationUserService,
    OrganizationInvitationService,
    RedisLockProvider,
    BoxLookupCacheInvalidationService,
    {
      provide: BoxRepository,
      inject: [DataSource, EventEmitter2, BoxLookupCacheInvalidationService],
      useFactory: (
        dataSource: DataSource,
        eventEmitter: EventEmitter2,
        boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
      ) => new BoxRepository(dataSource, eventEmitter, boxLookupCacheInvalidationService),
    },
  ],
  exports: [
    OrganizationService,
    OrganizationRoleService,
    OrganizationUserService,
    OrganizationInvitationService,
  ],
})
export class OrganizationModule {}
