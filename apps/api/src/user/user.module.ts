/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { UserController } from './user.controller'
import { UserService } from './user.service'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from './user.entity'
import { Auth0ManagementService } from './auth0-management.service'
import { LinkedIdentityService } from './linked-identity.service'

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UserController],
  providers: [UserService, Auth0ManagementService, LinkedIdentityService],
  exports: [UserService, LinkedIdentityService],
})
export class UserModule {}
