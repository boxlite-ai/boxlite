/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { UsageService } from './usage.service'

@ApiTags('usage')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard)
@Controller()
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get('/organization/:organizationId/metering')
  @UseGuards(OrganizationActionGuard)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  getOrganizationMetering(
    @Param('organizationId') organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('boxId') boxId?: string,
  ) {
    return this.usageService.getOrganizationMeteringView(organizationId, {
      from: this.parseOptionalDate('from', from),
      to: this.parseOptionalDate('to', to),
      limit: this.parseOptionalLimit(limit),
      boxId,
    })
  }

  private parseOptionalDate(label: string, value: string | undefined): Date | undefined {
    if (!value) {
      return undefined
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid ${label} date`)
    }
    return date
  }

  private parseOptionalLimit(value: string | undefined): number | undefined {
    if (!value) {
      return undefined
    }

    const limit = Number(value)
    if (!Number.isFinite(limit)) {
      throw new BadRequestException('Invalid limit')
    }
    return limit
  }
}
