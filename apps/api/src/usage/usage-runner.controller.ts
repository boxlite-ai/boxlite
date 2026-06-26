/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../auth/runner-auth.guard'
import { ReportBoxActualUsageDto } from './dto/report-box-actual-usage.dto'
import { UsageService } from './usage.service'

/**
 * Runner-facing ingest for actual (cgroup-measured) box usage. Authenticated
 * with RunnerAuthGuard (same pattern as JobController), distinct from the
 * user-facing read endpoint in UsageController.
 */
@ApiTags('usage')
@Controller('usage')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class UsageRunnerController {
  constructor(private readonly usageService: UsageService) {}

  @Post('box/:boxId/actual')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Report a box actual cgroup usage (runner -> control-plane)',
    operationId: 'reportBoxActualUsage',
  })
  @ApiParam({ name: 'boxId', description: 'ID of the box', type: 'string' })
  async reportBoxActualUsage(@Param('boxId') boxId: string, @Body() dto: ReportBoxActualUsageDto): Promise<void> {
    await this.usageService.recordActualUsage(boxId, dto)
  }
}
