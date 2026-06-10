/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminOverviewService } from '../services/overview.service'
import {
  AdminBoxItemDto,
  AdminMachineItemDto,
  AdminOverviewDto,
  AdminRunnerItemDto,
  AdminUserItemDto,
} from '../dto/admin-overview.dto'

@ApiTags('admin')
@Controller('admin/overview')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminOverviewController {
  constructor(private readonly adminOverviewService: AdminOverviewService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin KPI summary',
    operationId: 'adminGetOverview',
  })
  @ApiResponse({
    status: 200,
    type: AdminOverviewDto,
  })
  async getOverview(): Promise<AdminOverviewDto> {
    return this.adminOverviewService.getOverview()
  }

  @Get('users')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List all users (cross-org)',
    operationId: 'adminListUsers',
  })
  @ApiResponse({
    status: 200,
    type: [AdminUserItemDto],
  })
  async listUsers(): Promise<AdminUserItemDto[]> {
    return this.adminOverviewService.listUsers()
  }

  @Get('boxes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List all boxes (cross-org)',
    operationId: 'adminListBoxes',
  })
  @ApiResponse({
    status: 200,
    type: [AdminBoxItemDto],
  })
  async listBoxes(): Promise<AdminBoxItemDto[]> {
    return this.adminOverviewService.listBoxes()
  }

  @Get('runners')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List all runners with full details',
    operationId: 'adminListRunnersOverview',
  })
  @ApiResponse({
    status: 200,
    type: [AdminRunnerItemDto],
  })
  async listRunners(): Promise<AdminRunnerItemDto[]> {
    return this.adminOverviewService.listRunners()
  }

  @Get('machines')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Runner-as-machine resource view',
    operationId: 'adminListMachines',
  })
  @ApiResponse({
    status: 200,
    type: [AdminMachineItemDto],
  })
  async listMachines(): Promise<AdminMachineItemDto[]> {
    return this.adminOverviewService.listMachines()
  }
}
