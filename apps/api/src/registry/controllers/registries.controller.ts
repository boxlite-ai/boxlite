/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { CreateRegistryCredentialDto, RegistryCredentialDto } from '../dto/registry-credential.dto'
import { RegistriesService } from '../services/registries.service'

@ApiTags('registries')
@Controller('registries')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class RegistriesController {
  constructor(private readonly registries: RegistriesService) {}

  @Get()
  @ApiOperation({ summary: 'List registry credentials', operationId: 'listRegistryCredentials' })
  @ApiResponse({ status: 200, type: [RegistryCredentialDto] })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_REGISTRIES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<RegistryCredentialDto[]> {
    return (await this.registries.list(authContext.organizationId)).map(RegistryCredentialDto.from)
  }

  @Post()
  @ApiOperation({
    summary: 'Add a registry credential',
    description:
      'A login for a private registry. The password is stored where this API cannot read it back, and is never returned.',
    operationId: 'createRegistryCredential',
  })
  @ApiResponse({ status: 201, type: RegistryCredentialDto })
  @ApiResponse({ status: 409, description: 'A credential for this registry and prefix already exists' })
  @ApiResponse({ status: 501, description: 'Private registries are not enabled in this deployment' })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_REGISTRIES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.REGISTRY_CREDENTIAL,
    targetIdFromResult: (result: RegistryCredentialDto) => result?.id,
    requestMetadata: {
      // Named fields, never the body: the body carries the password.
      body: (req: TypedRequest<CreateRegistryCredentialDto>) => ({
        registryHost: req.body?.registryHost,
        repositoryPrefix: req.body?.repositoryPrefix,
        username: req.body?.username,
      }),
    },
  })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() request: CreateRegistryCredentialDto,
  ): Promise<RegistryCredentialDto> {
    const created = await this.registries.create(authContext.organizationId, authContext.userId ?? null, request)
    return RegistryCredentialDto.from(created)
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a registry credential', operationId: 'deleteRegistryCredential' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'The credential is gone, and its password is destroyed' })
  @ApiResponse({ status: 404, description: 'No such credential in this organization' })
  @ApiResponse({
    status: 409,
    description: 'Boxes that have not been destroyed still pull through it; their ids are listed',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_REGISTRIES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.REGISTRY_CREDENTIAL,
    targetIdFromRequest: (req) => req.params.id,
  })
  async delete(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.registries.delete(authContext.organizationId, id)
  }
}
