/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { MetricsResponseDto } from '../../box-telemetry/dto/metrics-response.dto'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../../box-telemetry/dto/paginated-traces.dto'
import { TraceSpanDto } from '../../box-telemetry/dto/trace-span.dto'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { Request } from 'express'
import { RequireFlagsEnabled } from '@openfeature/nestjs-sdk'
import { FeatureFlags } from '../../common/constants/feature-flags'
import {
  TenantLogsQueryDto,
  TenantMetricsQueryDto,
  TenantTelemetryRangeQueryDto,
  TenantTraceDetailQueryDto,
} from '../dto/tenant-observability-query.dto'
import { TenantObservabilityService } from '../services/tenant-observability.service'

const queryAuditMetadata: Record<string, (request: Request) => unknown> = {
  query: (req) => ({
    from: req.query.from,
    to: req.query.to,
    sources: req.query.sources,
    boxId: req.query.boxId,
    runnerId: req.query.runnerId,
    jobId: req.query.jobId,
    hasSearch: typeof req.query.search === 'string' && req.query.search.length > 0,
    hasTraceId: typeof req.query.traceId === 'string' && req.query.traceId.length > 0,
    page: req.query.page,
    limit: req.query.limit,
  }),
}

@ApiTags('observability')
@Controller('observability')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class TenantObservabilityController {
  constructor(private readonly observability: TenantObservabilityService) {}

  @Get('logs')
  @ApiOperation({ operationId: 'getTenantLogs', summary: 'Search tenant-scoped platform and Box logs' })
  @ApiResponse({ status: 200, type: PaginatedLogsDto })
  @RequireFlagsEnabled({ flags: [{ flagKey: FeatureFlags.TENANT_OBSERVABILITY, defaultValue: false }] })
  @Audit({ action: AuditAction.READ, targetType: AuditTarget.OBSERVABILITY, requestMetadata: queryAuditMetadata })
  getLogs(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() query: TenantLogsQueryDto,
  ): Promise<PaginatedLogsDto> {
    return this.observability.getLogs(authContext.organizationId, query)
  }

  @Get('traces')
  @ApiOperation({ operationId: 'getTenantTraces', summary: 'Search tenant-scoped distributed traces' })
  @ApiResponse({ status: 200, type: PaginatedTracesDto })
  @RequireFlagsEnabled({ flags: [{ flagKey: FeatureFlags.TENANT_OBSERVABILITY, defaultValue: false }] })
  @Audit({ action: AuditAction.READ, targetType: AuditTarget.OBSERVABILITY, requestMetadata: queryAuditMetadata })
  getTraces(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() query: TenantTelemetryRangeQueryDto,
  ): Promise<PaginatedTracesDto> {
    return this.observability.getTraces(authContext.organizationId, query)
  }

  @Get('traces/:traceId')
  @ApiOperation({ operationId: 'getTenantTraceSpans', summary: 'Get every tenant-owned span in a trace' })
  @ApiResponse({ status: 200, type: [TraceSpanDto] })
  @RequireFlagsEnabled({ flags: [{ flagKey: FeatureFlags.TENANT_OBSERVABILITY, defaultValue: false }] })
  @Audit({ action: AuditAction.READ, targetType: AuditTarget.OBSERVABILITY, requestMetadata: queryAuditMetadata })
  getTraceSpans(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('traceId') traceId: string,
    @Query() query: TenantTraceDetailQueryDto,
  ): Promise<TraceSpanDto[]> {
    if (!/^[0-9a-fA-F]{32}$/.test(traceId)) {
      throw new NotFoundException('Trace not found')
    }
    return this.observability.getTraceSpans(authContext.organizationId, traceId, query.boxId)
  }

  @Get('metrics')
  @ApiOperation({ operationId: 'getTenantMetrics', summary: 'Get allowlisted metrics for an owned Box' })
  @ApiResponse({ status: 200, type: MetricsResponseDto })
  @RequireFlagsEnabled({ flags: [{ flagKey: FeatureFlags.TENANT_OBSERVABILITY, defaultValue: false }] })
  @Audit({ action: AuditAction.READ, targetType: AuditTarget.OBSERVABILITY, requestMetadata: queryAuditMetadata })
  getMetrics(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() query: TenantMetricsQueryDto,
  ): Promise<MetricsResponseDto> {
    return this.observability.getMetrics(authContext.organizationId, query)
  }
}
