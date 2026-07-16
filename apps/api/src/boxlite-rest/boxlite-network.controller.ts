/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger'
import { BoxService } from '../box/services/box.service'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

// New REST-only network surface. Deliberately does not mount at /v1/boxes.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1/:prefix/boxes')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteNetworkController {
  constructor(private readonly boxService: BoxService) {}

  @Post(':boxId/network/tunnel')
  @HttpCode(HttpStatus.OK)
  async describeBoxTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
  ) {
    const { url } = await this.boxService.getPortPreviewUrl(boxId, authContext.organizationId, port)
    return { url }
  }
}
