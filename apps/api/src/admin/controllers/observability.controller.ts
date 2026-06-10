/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request } from 'express'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { MetricsResponseDto } from '../../box-telemetry/dto/metrics-response.dto'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../../box-telemetry/dto/paginated-traces.dto'
import { TraceSpanDto } from '../../box-telemetry/dto/trace-span.dto'
import { SystemRole } from '../../user/enums/system-role.enum'
import {
  AdminObservabilityLogsQueryParamsDto,
  AdminObservabilityMetricsQueryParamsDto,
  AdminObservabilityQueryParamsDto,
} from '../dto/observability-query.dto'
import {
  AdminObservabilityInvestigateQueryParamsDto,
  AdminObservabilityInvestigateResponseDto,
} from '../dto/observability-investigate.dto'
import { AdminObservabilityStatusDto } from '../dto/observability-status.dto'
import { AdminObservabilityService } from '../services/observability.service'

const OBSERVABILITY_AUDIT_QUERY_KEYS = [
  'from',
  'to',
  'page',
  'limit',
  'layer',
  'serviceName',
  'orgId',
  'userId',
  'boxId',
  'runnerId',
  'machineId',
  'traceId',
  'requestId',
  'operationId',
  'executionId',
  'jobId',
  'severities',
  'metricNames',
] as const

const OBSERVABILITY_TARGET_ID_KEYS = [
  'traceId',
  'userId',
  'boxId',
  'runnerId',
  'machineId',
  'executionId',
  'jobId',
  'requestId',
  'operationId',
] as const

function firstQueryValue(value: unknown): string | undefined {
  const resolvedValue = Array.isArray(value) ? value[0] : value
  return typeof resolvedValue === 'string' && resolvedValue.length > 0 ? resolvedValue : undefined
}

function resolveObservabilityTargetId(req: Request): string | undefined {
  for (const key of OBSERVABILITY_TARGET_ID_KEYS) {
    const value = firstQueryValue(req.query[key])
    if (value) {
      return `${key}:${value}`
    }
  }

  return undefined
}

function buildObservabilityAuditQuery(req: Request): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const key of OBSERVABILITY_AUDIT_QUERY_KEYS) {
    const value = req.query[key]
    if (value !== undefined) {
      metadata[key] = value
    }
  }

  const search = firstQueryValue(req.query.search)
  if (search) {
    metadata.search = { present: true, length: search.length }
  }

  return metadata
}

const OBSERVABILITY_READ_AUDIT = {
  action: AuditAction.READ,
  targetType: AuditTarget.OBSERVABILITY,
  targetIdFromRequest: resolveObservabilityTargetId,
  requestMetadata: {
    surface: () => 'admin_observability',
    query: buildObservabilityAuditQuery,
  },
}

@ApiTags('admin')
@Controller('admin/observability')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminObservabilityController {
  constructor(private readonly observabilityService: AdminObservabilityService) {}

  @Get('status')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get admin observability backend and layer status',
    operationId: 'adminGetObservabilityStatus',
  })
  @ApiResponse({ status: 200, type: AdminObservabilityStatusDto })
  @Audit(OBSERVABILITY_READ_AUDIT)
  async getStatus(): Promise<AdminObservabilityStatusDto> {
    return this.observabilityService.getStatus()
  }

  @Get('logs')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get admin-scoped logs',
    operationId: 'adminGetObservabilityLogs',
  })
  @ApiResponse({ status: 200, type: PaginatedLogsDto })
  @Audit(OBSERVABILITY_READ_AUDIT)
  async getLogs(@Query() queryParams: AdminObservabilityLogsQueryParamsDto): Promise<PaginatedLogsDto> {
    return this.observabilityService.getLogs(queryParams)
  }

  @Get('traces')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get admin-scoped traces',
    operationId: 'adminGetObservabilityTraces',
  })
  @ApiResponse({ status: 200, type: PaginatedTracesDto })
  @Audit(OBSERVABILITY_READ_AUDIT)
  async getTraces(@Query() queryParams: AdminObservabilityQueryParamsDto): Promise<PaginatedTracesDto> {
    return this.observabilityService.getTraces({
      ...queryParams,
      page: queryParams.page ?? 1,
      limit: queryParams.limit ?? 100,
    })
  }

  @Get('traces/:traceId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get admin-scoped trace spans',
    operationId: 'adminGetObservabilityTraceSpans',
  })
  @ApiParam({ name: 'traceId', type: 'string' })
  @ApiResponse({ status: 200, type: [TraceSpanDto] })
  @Audit({
    ...OBSERVABILITY_READ_AUDIT,
    targetIdFromRequest: (req) => `traceId:${req.params.traceId}`,
  })
  async getTraceSpans(
    @Param('traceId') traceId: string,
    @Query() queryParams: AdminObservabilityQueryParamsDto,
  ): Promise<TraceSpanDto[]> {
    return this.observabilityService.getTraceSpans(traceId, queryParams)
  }

  @Get('metrics')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get admin-scoped metrics',
    operationId: 'adminGetObservabilityMetrics',
  })
  @ApiResponse({ status: 200, type: MetricsResponseDto })
  @Audit(OBSERVABILITY_READ_AUDIT)
  async getMetrics(@Query() queryParams: AdminObservabilityMetricsQueryParamsDto): Promise<MetricsResponseDto> {
    return this.observabilityService.getMetrics(queryParams)
  }

  @Get('investigate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Investigate related observability and platform state from trace or resource identifiers',
    operationId: 'adminInvestigateObservability',
  })
  @ApiResponse({ status: 200, type: AdminObservabilityInvestigateResponseDto })
  @Audit(OBSERVABILITY_READ_AUDIT)
  async investigate(
    @Query() queryParams: AdminObservabilityInvestigateQueryParamsDto,
  ): Promise<AdminObservabilityInvestigateResponseDto> {
    return this.observabilityService.investigate({
      ...queryParams,
      page: queryParams.page ?? 1,
      limit: queryParams.limit ?? 100,
    })
  }
}
