/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { MetricsResponseDto } from '../../sandbox-telemetry/dto/metrics-response.dto'
import { PaginatedLogsDto } from '../../sandbox-telemetry/dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../../sandbox-telemetry/dto/paginated-traces.dto'
import {
  LogsQueryParamsDto,
  MetricsQueryParamsDto,
  TelemetryQueryParamsDto,
} from '../../sandbox-telemetry/dto/telemetry-query-params.dto'
import { TraceSpanDto } from '../../sandbox-telemetry/dto/trace-span.dto'
import { SandboxTelemetryService } from '../../sandbox-telemetry/services/sandbox-telemetry.service'
import { SystemRole } from '../../user/enums/system-role.enum'

@ApiTags('admin')
@Controller('admin/telemetry')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminTelemetryController {
  constructor(private readonly sandboxTelemetryService: SandboxTelemetryService) {}

  @Get('logs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get platform logs',
    operationId: 'adminGetPlatformLogs',
  })
  @ApiResponse({
    status: 200,
    type: PaginatedLogsDto,
  })
  async getPlatformLogs(@Query() queryParams: LogsQueryParamsDto): Promise<PaginatedLogsDto> {
    return this.sandboxTelemetryService.getPlatformLogs(
      queryParams.from,
      queryParams.to,
      queryParams.page ?? 1,
      queryParams.limit ?? 100,
      queryParams.severities,
      queryParams.search,
    )
  }

  @Get('traces')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get platform traces',
    operationId: 'adminGetPlatformTraces',
  })
  @ApiResponse({
    status: 200,
    type: PaginatedTracesDto,
  })
  async getPlatformTraces(@Query() queryParams: TelemetryQueryParamsDto): Promise<PaginatedTracesDto> {
    return this.sandboxTelemetryService.getPlatformTraces(
      queryParams.from,
      queryParams.to,
      queryParams.page ?? 1,
      queryParams.limit ?? 100,
    )
  }

  @Get('traces/:traceId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get platform trace spans',
    operationId: 'adminGetPlatformTraceSpans',
  })
  @ApiParam({
    name: 'traceId',
    description: 'ID of the trace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    type: [TraceSpanDto],
  })
  async getPlatformTraceSpans(@Param('traceId') traceId: string): Promise<TraceSpanDto[]> {
    return this.sandboxTelemetryService.getPlatformTraceSpans(traceId)
  }

  @Get('metrics')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get platform metrics',
    operationId: 'adminGetPlatformMetrics',
  })
  @ApiResponse({
    status: 200,
    type: MetricsResponseDto,
  })
  async getPlatformMetrics(@Query() queryParams: MetricsQueryParamsDto): Promise<MetricsResponseDto> {
    return this.sandboxTelemetryService.getPlatformMetrics(queryParams.from, queryParams.to, queryParams.metricNames)
  }
}
