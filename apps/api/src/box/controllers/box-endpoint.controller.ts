/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, Header, HttpCode, Param, Put, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { ProxyContext } from '../../common/interfaces/proxy-context.interface'
import { isRegionProxyContext, RegionProxyContext } from '../../common/interfaces/region-proxy.interface'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { BindBoxEndpointDto, BoxEndpointDto, BoxEndpointNameDto } from '../dto/box-endpoint.dto'
import { BoxEndpointProxyGuard } from '../guards/box-endpoint-proxy.guard'
import { BoxEndpointService } from '../services/box-endpoint.service'

@ApiTags('box-endpoints')
@ApiBearerAuth()
@Controller('box-endpoints')
@UseGuards(CombinedAuthGuard)
export class BoxEndpointController {
  constructor(private readonly endpoints: BoxEndpointService) {}

  @Get()
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiOperation({ summary: 'List official box endpoints', operationId: 'listBoxEndpoints' })
  @ApiResponse({ status: 200, type: [BoxEndpointDto] })
  @UseGuards(OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
  list(@AuthContext() context: OrganizationAuthContext): Promise<BoxEndpointDto[]> {
    return this.endpoints.list(context.organizationId)
  }

  @Put(':name')
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiOperation({ summary: 'Bind an official hostname to a box port', operationId: 'bindBoxEndpoint' })
  @ApiResponse({ status: 200, type: BoxEndpointDto })
  @UseGuards(OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.BOX_ENDPOINT,
    targetIdFromRequest: (req) => req.params.name,
  })
  bind(
    @AuthContext() context: OrganizationAuthContext,
    @Param() params: BoxEndpointNameDto,
    @Body() input: BindBoxEndpointDto,
  ): Promise<BoxEndpointDto> {
    return this.endpoints.bind(context.organizationId, params.name, input)
  }

  @Delete(':name')
  @HttpCode(204)
  @ApiHeader(CustomHeaders.ORGANIZATION_ID)
  @ApiOperation({ summary: 'Revoke a binding, retaining its name reservation', operationId: 'revokeBoxEndpoint' })
  @UseGuards(OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.BOX_ENDPOINT,
    targetIdFromRequest: (req) => req.params.name,
  })
  revoke(@AuthContext() context: OrganizationAuthContext, @Param() params: BoxEndpointNameDto): Promise<void> {
    return this.endpoints.revoke(context.organizationId, params.name)
  }

  @Get('resolve/:name')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Resolve an official endpoint for a proxy', operationId: 'resolveBoxEndpoint' })
  @ApiResponse({ status: 200, type: BoxEndpointDto })
  @UseGuards(BoxEndpointProxyGuard)
  resolve(
    @AuthContext() context: ProxyContext | RegionProxyContext,
    @Param() params: BoxEndpointNameDto,
  ): Promise<BoxEndpointDto> {
    return this.endpoints.resolve(params.name, isRegionProxyContext(context) ? context.regionId : undefined)
  }
}
