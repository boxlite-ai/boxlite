/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiOAuth2, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxAccessGuard } from '../box/guards/box-access.guard'
import { BoxUsageResult, UsageService } from './usage.service'

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

@ApiTags('usage')
@Controller('usage')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get('box/:boxId')
  @ApiOperation({
    summary: 'Get aggregated usage totals for a box over a time range',
    operationId: 'getBoxUsage',
  })
  @ApiParam({ name: 'boxId', description: 'ID of the box', type: 'string' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO start (default: 30d ago)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO end (default: now)' })
  @ApiResponse({ status: 200, description: 'Aggregated box usage totals' })
  @UseGuards(BoxAccessGuard)
  async getBoxUsage(
    @Param('boxId') boxId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<BoxUsageResult> {
    const toDate = to ? new Date(to) : new Date()
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - DEFAULT_RANGE_MS)
    // Fail fast at the boundary: an unparsable ISO string becomes Invalid Date,
    // which would otherwise surface as an opaque DB error or silently-zero totals.
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('from/to must be valid ISO-8601 timestamps')
    }
    if (fromDate > toDate) {
      throw new BadRequestException('from must not be after to')
    }
    return this.usageService.getBoxUsage(boxId, fromDate, toDate)
  }
}
