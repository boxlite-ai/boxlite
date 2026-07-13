/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiParam, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { BillingReadService, parseBillingRange } from './billing-read.service'

@ApiTags('billing')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@Controller('organization/:organizationId/billing')
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
export class BillingController {
  constructor(private readonly billingReadService: BillingReadService) {}

  @Get('overview')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  getOverview(@Param('organizationId') organizationId: string, @Query('from') from?: string, @Query('to') to?: string) {
    const range = parseBillingRange(from, to)
    return this.billingReadService.getOverview(organizationId, range.from, range.to)
  }

  @Get('pricing')
  @ApiParam({ name: 'organizationId', type: String })
  getPricing() {
    return this.billingReadService.getPricing()
  }

  @Get('boxes/:boxId')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  getBoxUsage(@Param('organizationId') organizationId: string, @Param('boxId') boxId: string) {
    return this.billingReadService.getBoxUsage(organizationId, boxId)
  }
}
