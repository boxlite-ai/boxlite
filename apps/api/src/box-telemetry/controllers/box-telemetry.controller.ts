/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { ApiOAuth2, ApiResponse, ApiOperation, ApiParam, ApiTags, ApiHeader, ApiBearerAuth } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { BoxAccessGuard } from '../../box/guards/box-access.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { BoxTelemetryService } from '../services/box-telemetry.service'
import { LogsQueryParamsDto, TelemetryQueryParamsDto, MetricsQueryParamsDto } from '../dto/telemetry-query-params.dto'
import { PaginatedLogsDto } from '../dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../dto/paginated-traces.dto'
import { TraceSpanDto } from '../dto/trace-span.dto'
import { MetricsResponseDto } from '../dto/metrics-response.dto'
import { RequireFlagsEnabled } from '@openfeature/nestjs-sdk'
import { AnalyticsApiDisabledGuard } from '../guards/analytics-api-disabled.guard'

@ApiTags('box')
@Controller('box')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard, AnalyticsApiDisabledGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class BoxTelemetryController {
  constructor(private readonly boxTelemetryService: BoxTelemetryService) {}

  @Get(':boxId/telemetry/logs')
  @ApiOperation({
    summary: 'Get box logs',
    operationId: 'getBoxLogs',
    description: 'Retrieve OTEL logs for a box within a time range',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of log entries',
    type: PaginatedLogsDto,
  })
  @UseGuards(BoxAccessGuard)
  @RequireFlagsEnabled({ flags: [{ flagKey: 'organization_experiments', defaultValue: true }] })
  async getBoxLogs(@Param('boxId') boxId: string, @Query() queryParams: LogsQueryParamsDto): Promise<PaginatedLogsDto> {
    return this.boxTelemetryService.getLogs(
      boxId,
      queryParams.from,
      queryParams.to,
      queryParams.page ?? 1,
      queryParams.limit ?? 100,
      queryParams.severities,
      queryParams.search,
    )
  }

  @Get(':boxId/telemetry/traces')
  @ApiOperation({
    summary: 'Get box traces',
    operationId: 'getBoxTraces',
    description: 'Retrieve OTEL traces for a box within a time range',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of trace summaries',
    type: PaginatedTracesDto,
  })
  @UseGuards(BoxAccessGuard)
  @RequireFlagsEnabled({ flags: [{ flagKey: 'organization_experiments', defaultValue: true }] })
  async getBoxTraces(
    @Param('boxId') boxId: string,
    @Query() queryParams: TelemetryQueryParamsDto,
  ): Promise<PaginatedTracesDto> {
    return this.boxTelemetryService.getTraces(
      boxId,
      queryParams.from,
      queryParams.to,
      queryParams.page ?? 1,
      queryParams.limit ?? 100,
    )
  }

  @Get(':boxId/telemetry/traces/:traceId')
  @ApiOperation({
    summary: 'Get trace spans',
    operationId: 'getBoxTraceSpans',
    description: 'Retrieve all spans for a specific trace',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'traceId',
    description: 'ID of the trace',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'List of spans in the trace',
    type: [TraceSpanDto],
  })
  @UseGuards(BoxAccessGuard)
  @RequireFlagsEnabled({ flags: [{ flagKey: 'organization_experiments', defaultValue: true }] })
  async getBoxTraceSpans(@Param('boxId') boxId: string, @Param('traceId') traceId: string): Promise<TraceSpanDto[]> {
    return this.boxTelemetryService.getTraceSpans(boxId, traceId)
  }

  @Get(':boxId/telemetry/metrics')
  @ApiOperation({
    summary: 'Get box metrics',
    operationId: 'getBoxMetrics',
    description: 'Retrieve OTEL metrics for a box within a time range',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Metrics time series data',
    type: MetricsResponseDto,
  })
  @UseGuards(BoxAccessGuard)
  @RequireFlagsEnabled({ flags: [{ flagKey: 'organization_experiments', defaultValue: true }] })
  async getBoxMetrics(
    @Param('boxId') boxId: string,
    @Query() queryParams: MetricsQueryParamsDto,
  ): Promise<MetricsResponseDto> {
    return this.boxTelemetryService.getMetrics(boxId, queryParams.from, queryParams.to, queryParams.metricNames)
  }
}
