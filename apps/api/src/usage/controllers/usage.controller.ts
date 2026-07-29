/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { UsageChartQueryDto, UsageRangeQueryDto } from '../dto/usage-query.dto'
import { AggregatedUsageDto, BoxUsageDto, UsageChartPointDto, UsagePeriodDto } from '../dto/usage-response.dto'
import { UsageQueryService } from '../services/usage-query.service'

@ApiTags('usage')
@Controller('organization/:organizationId')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class UsageController {
  constructor(private readonly usageQueryService: UsageQueryService) {}

  @Get('box/:boxId/usage')
  @ApiOperation({
    summary: 'Get box usage periods',
    description: 'Retrieve usage periods for a specific box within a time range',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiParam({ name: 'boxId', type: String })
  @ApiResponse({ status: 200, type: [UsagePeriodDto] })
  async getBoxUsagePeriods(
    @Param('organizationId') organizationId: string,
    @Param('boxId') boxId: string,
    @Query() query: UsageRangeQueryDto,
  ): Promise<UsagePeriodDto[]> {
    const { from, to } = query.toDateRange()
    return this.usageQueryService.getBoxUsagePeriods(organizationId, boxId, from, to)
  }

  @Get('usage/aggregated')
  @ApiOperation({
    summary: 'Get aggregated usage',
    description: 'Retrieve aggregated usage for an organization within a time range',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiResponse({ status: 200, type: AggregatedUsageDto })
  async getAggregatedUsage(
    @Param('organizationId') organizationId: string,
    @Query() query: UsageRangeQueryDto,
  ): Promise<AggregatedUsageDto> {
    const { from, to } = query.toDateRange()
    return this.usageQueryService.getAggregatedUsage(organizationId, from, to)
  }

  @Get('usage/box')
  @ApiOperation({
    summary: 'Get per-box usage',
    description: 'Retrieve per-box usage for an organization within a time range',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiResponse({ status: 200, type: [BoxUsageDto] })
  async getBoxUsage(
    @Param('organizationId') organizationId: string,
    @Query() query: UsageRangeQueryDto,
  ): Promise<BoxUsageDto[]> {
    const { from, to } = query.toDateRange()
    return this.usageQueryService.getBoxUsage(organizationId, from, to)
  }

  @Get('usage/chart')
  @ApiOperation({
    summary: 'Get usage chart data',
    description: 'Retrieve UTC-day usage chart points for an organization within a time range',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiResponse({ status: 200, type: [UsageChartPointDto] })
  async getUsageChart(
    @Param('organizationId') organizationId: string,
    @Query() query: UsageChartQueryDto,
  ): Promise<UsageChartPointDto[]> {
    const { from, to } = query.toDateRange()
    return this.usageQueryService.getUsageChart(organizationId, from, to, query.region)
  }
}
