/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { BoxAccessGuard } from '../guards/box-access.guard'
import { BoxAccessGrantService } from '../services/box-access-grant.service'
import { BoxAccessGrantDto, BoxAccessGrantResponseDto, CreateBoxAccessGrantDto } from '../dto/box-access-grant.dto'

@ApiTags('box-access-grant')
@Controller('box')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class BoxAccessGrantController {
  constructor(private readonly boxAccessGrantService: BoxAccessGrantService) {}

  @Post(':boxIdOrName/access-grants')
  @ApiOperation({
    summary: 'Create a box-scoped access grant',
    operationId: 'createBoxAccessGrant',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Access grant created. The plaintext app key is returned once and cannot be recovered later.',
    type: BoxAccessGrantResponseDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.CREATE_ACCESS_GRANT,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: BoxAccessGrantResponseDto) => result?.boxId,
    requestMetadata: {
      body: (req) => ({
        scopes: req.body?.scopes,
        expiresInSeconds: req.body?.expiresInSeconds,
      }),
    },
  })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Body() createBoxAccessGrantDto: CreateBoxAccessGrantDto,
  ): Promise<BoxAccessGrantResponseDto> {
    return this.boxAccessGrantService.create(
      boxIdOrName,
      createBoxAccessGrantDto,
      authContext.organizationId,
      authContext.userId,
    )
  }

  @Get(':boxIdOrName/access-grants')
  @ApiOperation({
    summary: 'List box-scoped access grants',
    operationId: 'listBoxAccessGrants',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Access grants for the box. Never includes the app key or its digest.',
    type: [BoxAccessGrantDto],
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  async list(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
  ): Promise<BoxAccessGrantDto[]> {
    return this.boxAccessGrantService.list(boxIdOrName, authContext.organizationId)
  }

  @Delete(':boxIdOrName/access-grants/:grantId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a box-scoped access grant',
    operationId: 'revokeBoxAccessGrant',
  })
  @ApiParam({
    name: 'boxIdOrName',
    description: 'ID or name of the box',
    type: 'string',
  })
  @ApiParam({
    name: 'grantId',
    description: 'ID of the access grant to revoke',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Access grant has been revoked',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(BoxAccessGuard)
  @Audit({
    action: AuditAction.REVOKE_ACCESS_GRANT,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
  })
  async revoke(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    await this.boxAccessGrantService.revoke(boxIdOrName, grantId, authContext.organizationId)
  }
}
