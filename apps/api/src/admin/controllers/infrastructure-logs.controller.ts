/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeController, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { AuthContext as IAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { InfrastructureLogsDto, InfrastructureLogsQueryDto } from '../dto/infrastructure-logs.dto'
import { InfrastructureLogsService } from '../services/infrastructure-logs.service'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { PlatformLogsQueryDto } from '../dto/platform-logs.dto'
import { PlatformLogsService } from '../services/platform-logs.service'

@ApiTags('admin')
@ApiExcludeController()
@Controller('admin/infrastructure-logs')
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, SystemActionGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class InfrastructureLogsController {
  constructor(
    private readonly infrastructureLogs: InfrastructureLogsService,
    private readonly platformLogs: PlatformLogsService,
  ) {}

  @Get('access')
  access(@AuthContext() authContext: IAuthContext): { canRead: boolean } {
    return { canRead: authContext.role === SystemRole.ADMIN }
  }

  @Get()
  @RequiredApiRole([SystemRole.ADMIN])
  @ApiOperation({ summary: 'Search infrastructure fallback logs', operationId: 'adminSearchInfrastructureLogs' })
  @ApiResponse({ status: 200, type: InfrastructureLogsDto })
  @Audit({
    action: AuditAction.READ,
    targetType: AuditTarget.INFRASTRUCTURE_LOGS,
    requestMetadata: {
      query: (req) => ({
        source: req.query.source,
        from: req.query.from,
        to: req.query.to,
        hasSearch: typeof req.query.search === 'string' && req.query.search.length > 0,
        limit: req.query.limit,
      }),
    },
  })
  query(@Query() query: InfrastructureLogsQueryDto): Promise<InfrastructureLogsDto> {
    return this.infrastructureLogs.query(query)
  }

  @Get('platform')
  @RequiredApiRole([SystemRole.ADMIN])
  @ApiOperation({ summary: 'Search allowlisted platform OTLP logs', operationId: 'adminSearchPlatformLogs' })
  @ApiResponse({ status: 200, type: PaginatedLogsDto })
  @Audit({
    action: AuditAction.READ,
    targetType: AuditTarget.INFRASTRUCTURE_LOGS,
    requestMetadata: {
      query: (req) => ({
        source: req.query.source,
        from: req.query.from,
        to: req.query.to,
        hasSearch: typeof req.query.search === 'string' && req.query.search.length > 0,
        hasTraceId: typeof req.query.traceId === 'string' && req.query.traceId.length > 0,
        page: req.query.page,
        limit: req.query.limit,
      }),
    },
  })
  queryPlatform(@Query() query: PlatformLogsQueryDto): Promise<PaginatedLogsDto> {
    return this.platformLogs.query(query)
  }
}
