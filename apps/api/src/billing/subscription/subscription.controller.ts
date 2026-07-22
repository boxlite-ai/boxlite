/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationMemberRole } from '../../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../../organization/guards/organization-action.guard'
import { SubscriptionPlanRequestDto, UserResourceMultipliersRequestDto } from './subscription.dto'
import { SubscriptionService } from './subscription.service'
import { UserResourceMultiplierService } from './user-resource-multiplier.service'

@ApiTags('billing')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@Controller('organization/:organizationId/billing')
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
@RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
export class SubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly userMultipliers: UserResourceMultiplierService,
  ) {}

  @Get('subscription')
  getSubscription(@Param('organizationId') organizationId: string) {
    return this.subscriptions.getSubscription(organizationId)
  }

  @Post('subscription/checkout')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  createCheckout(
    @Param('organizationId') organizationId: string,
    @Body() input: SubscriptionPlanRequestDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.subscriptions.createCheckout(organizationId, input.planCode, idempotencyKey)
  }

  @Put('subscription/plan')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  changePlan(
    @Param('organizationId') organizationId: string,
    @Body() input: SubscriptionPlanRequestDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.subscriptions.changePlan(organizationId, input.planCode, idempotencyKey)
  }

  @Get('users/:userId/resource-multipliers')
  getUserMultipliers(@Param('organizationId') organizationId: string, @Param('userId') userId: string) {
    return this.userMultipliers.getCurrent(organizationId, userId)
  }

  @Put('users/:userId/resource-multipliers')
  @HttpCode(200)
  setUserMultipliers(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() input: UserResourceMultipliersRequestDto,
  ) {
    return this.userMultipliers.setCurrent(organizationId, userId, input)
  }
}
