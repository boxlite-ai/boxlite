/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common'
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
import { SshCredentialAuthGuard } from '../guards/ssh-credential-auth.guard'
import { BoxAccessGrantService } from '../services/box-access-grant.service'
import { BoxService } from '../services/box.service'
import { TemporarySshCredentialService } from '../services/temporary-ssh-credential.service'
import {
  CreateTemporarySshCredentialDto,
  TemporarySshCredentialDto,
  TemporarySshCredentialResponseDto,
} from '../dto/temporary-ssh-credential.dto'

@ApiTags('ssh-access')
@Controller('box')
export class TemporarySshCredentialController {
  constructor(
    private readonly credentialService: TemporarySshCredentialService,
    private readonly grantService: BoxAccessGrantService,
    private readonly boxService: BoxService,
  ) {}

  @Post(':boxIdOrName/ssh-access')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a temporary SSH credential for a box',
    operationId: 'createTemporarySshCredential',
  })
  @ApiParam({ name: 'boxIdOrName', description: 'ID or name of the box', type: 'string' })
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiHeader(CustomHeaders.APP_KEY)
  @ApiOAuth2(['openid', 'profile', 'email'])
  @ApiBearerAuth()
  @ApiResponse({
    status: 201,
    description: 'SSH credential created and applied to the running guest.',
    type: TemporarySshCredentialResponseDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(SshCredentialAuthGuard)
  @Audit({
    action: AuditAction.CREATE_SSH_ACCESS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
    targetIdFromResult: (result: TemporarySshCredentialResponseDto) => result?.boxId,
    requestMetadata: {
      body: (req) => ({ grantId: req.body?.grantId }),
    },
  })
  async create(
    @Req() request: any,
    @Param('boxIdOrName') boxIdOrName: string,
    @Body() dto: CreateTemporarySshCredentialDto,
  ): Promise<TemporarySshCredentialResponseDto> {
    // SshCredentialAuthGuard sets exactly one of these depending on which
    // identity the request presented.
    const grant = request.appKeyGrant ?? (await this.grantForOrgCaller(boxIdOrName, dto.grantId, request.user))
    const createdBy = request.appKeyGrant ? request.appKeyGrant.createdBy : request.user.userId
    return this.credentialService.create(boxIdOrName, dto, grant, createdBy)
  }

  @Get(':boxIdOrName/ssh-access')
  @ApiOperation({
    summary: 'List temporary SSH credentials for a box',
    operationId: 'listTemporarySshCredentials',
  })
  @ApiParam({ name: 'boxIdOrName', description: 'ID or name of the box', type: 'string' })
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiOAuth2(['openid', 'profile', 'email'])
  @ApiBearerAuth()
  @ApiResponse({
    status: 200,
    description: 'SSH credentials for the box. Never includes the key body.',
    type: [TemporarySshCredentialDto],
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard, BoxAccessGuard)
  async list(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
  ): Promise<TemporarySshCredentialDto[]> {
    return this.credentialService.list(boxIdOrName, authContext.organizationId)
  }

  @Delete(':boxIdOrName/ssh-access/:credentialId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a temporary SSH credential',
    operationId: 'revokeTemporarySshCredential',
  })
  @ApiParam({ name: 'boxIdOrName', description: 'ID or name of the box', type: 'string' })
  @ApiParam({ name: 'credentialId', description: 'ID of the SSH credential to revoke', type: 'string' })
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiOAuth2(['openid', 'profile', 'email'])
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'SSH credential has been revoked' })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard, BoxAccessGuard)
  @Audit({
    action: AuditAction.REVOKE_SSH_ACCESS,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxIdOrName,
  })
  async revoke(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxIdOrName') boxIdOrName: string,
    @Param('credentialId') credentialId: string,
  ): Promise<void> {
    await this.credentialService.revoke(boxIdOrName, credentialId, authContext.organizationId)
  }

  private async grantForOrgCaller(boxIdOrName: string, grantId: string, authContext: OrganizationAuthContext) {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, authContext.organizationId)
    return this.grantService.findActiveForBox(box.id, grantId)
  }
}
