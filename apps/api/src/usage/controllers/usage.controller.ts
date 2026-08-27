/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationMemberRole } from '../../organization/decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../../organization/guards/organization-action.guard'
import {
  UsageConcurrencyGranularity,
  UsageConcurrencyQueryDto,
  UsageConcurrencySeriesDto,
} from '../dto/usage-concurrency.dto'
import { UsageConcurrencyService } from '../services/usage-concurrency.service'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

@ApiTags('usage')
@Controller('organizations/:organizationId')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class UsageController {
  constructor(private readonly usageConcurrencyService: UsageConcurrencyService) {}

  @Get('/concurrency')
  @ApiOperation({
    summary: 'Get organization concurrency timeline',
    operationId: 'getOrganizationUsageConcurrency',
  })
  @ApiResponse({
    status: 200,
    description: 'Compute-bearing box usage periods sampled as a bounded concurrency series.',
    type: UsageConcurrencySeriesDto,
  })
  @ApiParam({ name: 'organizationId', description: 'Organization ID', type: 'string' })
  @UseGuards(AuthGuard('jwt'), AuthenticatedRateLimitGuard, OrganizationActionGuard)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  getConcurrency(
    @Param('organizationId') organizationId: string,
    @Query() query: UsageConcurrencyQueryDto,
  ): Promise<UsageConcurrencySeriesDto> {
    const to = query.to ?? new Date()
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS)
    return this.usageConcurrencyService.getSeries(
      organizationId,
      from,
      to,
      query.granularity ?? UsageConcurrencyGranularity.DAY,
    )
  }
}
