/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { BoxTelemetryService } from '../../box-telemetry/services/box-telemetry.service'
import { PlatformLogSource, PlatformLogsQueryDto } from '../dto/platform-logs.dto'

const MAX_QUERY_RANGE_MS = 72 * 60 * 60 * 1000
const MAX_QUERY_EXECUTION_SECONDS = 4
const SERVICE_NAMES: Record<Exclude<PlatformLogSource, PlatformLogSource.BOX>, string> = {
  [PlatformLogSource.API]: 'boxlite-api',
  [PlatformLogSource.WORKER]: 'boxlite-worker',
  [PlatformLogSource.RUNNER]: 'boxlite-runner',
}

@Injectable()
export class PlatformLogsService {
  constructor(private readonly telemetry: BoxTelemetryService) {}

  async query(query: PlatformLogsQueryDto): Promise<PaginatedLogsDto> {
    if (!this.telemetry.isConfigured()) {
      throw new ServiceUnavailableException('ClickHouse log search is not configured')
    }

    const startTime = Date.parse(query.from)
    const endTime = Date.parse(query.to)
    if (startTime > endTime) {
      throw new BadRequestException('from must be before to')
    }
    if (endTime - startTime > MAX_QUERY_RANGE_MS) {
      throw new BadRequestException('Platform log searches are limited to 72 hours')
    }

    return this.telemetry.getLogsForService(
      this.getServiceName(query),
      query.from,
      query.to,
      query.page ?? 1,
      Math.min(query.limit ?? 50, 100),
      query.severities,
      query.search,
      query.traceId?.toLowerCase(),
      MAX_QUERY_EXECUTION_SECONDS,
    )
  }

  private getServiceName(query: PlatformLogsQueryDto): string {
    if (query.source === PlatformLogSource.BOX) {
      if (!query.boxId) {
        throw new BadRequestException('boxId is required for Box logs')
      }
      return `box-${query.boxId}`
    }

    return SERVICE_NAMES[query.source ?? PlatformLogSource.API]
  }
}
