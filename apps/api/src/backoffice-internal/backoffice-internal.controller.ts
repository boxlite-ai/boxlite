/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Header, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import {
  BackofficeWorkloadAuthGuard,
  BackofficeWorkloadRouteScope,
  RequireBackofficeWorkloadRoute,
} from './backoffice-workload-auth'

@ApiExcludeController()
@Controller('internal/backoffice/v1')
@UseGuards(BackofficeWorkloadAuthGuard)
export class BackofficeInternalController {
  @Get('readiness')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.READINESS)
  readiness() {
    return {
      service: 'boxlite-api',
      contract: { major: 1, minor: 0 },
      capabilities: [],
      generatedAt: new Date().toISOString(),
    }
  }
}
