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
import { UserRegistration } from './user-registration.entity'
import { UserRegistrationService } from './user-registration.service'
import { OrganizationReferralModule } from '../organization-referral/organization-referral.module'
import { BusinessEventOutboxModule } from '../business-events/business-event-outbox.module'

@Module({
  imports: [TypeOrmModule.forFeature([User, UserRegistration]), OrganizationReferralModule, BusinessEventOutboxModule],
  controllers: [UserController],
  providers: [UserService, UserRegistrationService],
  exports: [UserService],
})
export class UserModule {}
