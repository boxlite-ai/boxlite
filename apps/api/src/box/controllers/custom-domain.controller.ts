/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { CustomDomainService } from '../services/custom-domain.service'

/** Dashboard-only setup API; portable bind/unbind/list DTOs remain separate. */
@ApiExcludeController()
@Controller('organizations/:organizationId/custom-domains')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
export class CustomDomainController {
  constructor(private readonly domains: CustomDomainService) {}

  @Get()
  list(@Param('organizationId', ParseUUIDPipe) org: string) {
    return this.domains.list(org)
  }

  @Post()
  create(@Param('organizationId', ParseUUIDPipe) org: string, @Body() body: { hostname?: unknown }) {
    return this.domains.create(org, body?.hostname)
  }

  @Get(':id')
  get(@Param('organizationId', ParseUUIDPipe) org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.domains.get(org, id)
  }

  @Post(':id/verify')
  @HttpCode(202)
  verify(@Param('organizationId', ParseUUIDPipe) org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.domains.verify(org, id)
  }

  @Post(':id/prepare')
  @HttpCode(202)
  prepare(@Param('organizationId', ParseUUIDPipe) org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.domains.prepare(org, id)
  }

  @Post(':id/advance')
  @HttpCode(202)
  advance(@Param('organizationId', ParseUUIDPipe) org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.domains.advance(org, id)
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('organizationId', ParseUUIDPipe) org: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.domains.delete(org, id)
  }
}
