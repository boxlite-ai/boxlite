/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { Request } from 'express'
import { Audit, AUDIT_TARGET_ID } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { proxyCreate, proxyName, proxyPatch } from '../box/outbound-proxy/proxy-registration.input'
import { ProxyRegistryStore } from '../box/outbound-proxy/proxy-registry.store'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

@Controller(['v1/proxies', 'v1/:prefix/proxies'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
export class BoxliteOutboundProxyController {
  constructor(private readonly proxies: ProxyRegistryStore) {}

  @Get()
  async list(@AuthContext() caller: OrganizationAuthContext) {
    return { proxies: await this.proxies.list(caller.organizationId) }
  }

  @Get(':name')
  get(@AuthContext() caller: OrganizationAuthContext, @Param('name') name: string) {
    return this.proxies.get(caller.organizationId, proxyName(name))
  }

  @Post()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_PROXIES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.OUTBOUND_PROXY,
    targetIdFromResult: (result: { name: string }) => result.name,
  })
  create(@AuthContext() caller: OrganizationAuthContext, @Body() body: unknown) {
    return this.proxies.create(caller.organizationId, proxyCreate(body))
  }

  @Patch(':name')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_PROXIES])
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.OUTBOUND_PROXY,
    targetIdFromResult: (result: { name: string }) => result.name,
  })
  update(@AuthContext() caller: OrganizationAuthContext, @Param('name') name: string, @Body() body: unknown) {
    return this.proxies.update(caller.organizationId, proxyName(name), proxyPatch(body))
  }

  @Delete(':name')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_PROXIES])
  @Audit({ action: AuditAction.DELETE, targetType: AuditTarget.OUTBOUND_PROXY })
  async remove(
    @AuthContext() caller: OrganizationAuthContext,
    @Param('name') name: string,
    @Req() request: Request & { [AUDIT_TARGET_ID]?: string },
  ) {
    const target = proxyName(name)
    await this.proxies.remove(caller.organizationId, target)
    request[AUDIT_TARGET_ID] = target
  }
}
