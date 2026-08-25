/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { BackofficeBoxesQueryDto, BackofficeRunnersQueryDto } from './backoffice-inventory.dto'
import { BackofficeInventoryReader } from './backoffice-inventory.reader'
import {
  BackofficeWorkloadAuthGuard,
  BackofficeWorkloadRouteScope,
  RequireBackofficeWorkloadRoute,
} from './backoffice-workload-auth'

@ApiExcludeController()
@Controller('internal/backoffice/v1')
@UseGuards(BackofficeWorkloadAuthGuard)
export class BackofficeInternalController {
  constructor(private readonly inventory: BackofficeInventoryReader) {}

  @Get('readiness')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.READINESS)
  readiness() {
    return {
      service: 'boxlite-api',
      contract: { major: 1, minor: 0 },
      capabilities: ['boxes.read', 'runners.read'],
      generatedAt: new Date().toISOString(),
    }
  }

  @Get('boxes')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.BOXES)
  boxes(@Query() query: BackofficeBoxesQueryDto) {
    return this.inventory.boxes(query)
  }

  @Get('boxes/:boxId')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.BOX)
  box(@Param('boxId') boxId: string) {
    return this.inventory.box(boxId)
  }

  @Get('runners')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.RUNNERS)
  runners(@Query() query: BackofficeRunnersQueryDto) {
    return this.inventory.runners(query)
  }

  @Get('runners/:runnerId')
  @Header('Cache-Control', 'no-store')
  @RequireBackofficeWorkloadRoute(BackofficeWorkloadRouteScope.RUNNER)
  runner(@Param('runnerId') runnerId: string) {
    return this.inventory.runner(runnerId)
  }
}
