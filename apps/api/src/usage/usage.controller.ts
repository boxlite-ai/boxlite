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
import { GetBoxUsageQueryDto } from './dto/get-box-usage-query.dto'
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
  async getBoxUsage(@Param('boxId') boxId: string, @Query() query: GetBoxUsageQueryDto = {}): Promise<BoxUsageResult> {
    const toDate = query.to ? parseQueryDate('to', query.to) : new Date()
    const fromDate = query.from ? parseQueryDate('from', query.from) : new Date(toDate.getTime() - DEFAULT_RANGE_MS)
    if (fromDate > toDate) throw new BadRequestException('from must be before or equal to to')
    return this.usageService.getBoxUsage(boxId, fromDate, toDate)
  }
}

function parseQueryDate(name: 'from' | 'to', value: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be a valid ISO date string`)
  return date
}
