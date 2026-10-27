/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { HeldDomain, TunnelDomainService } from '../box/services/tunnel-domain.service'
import { DomainTargetDto } from './dto/domain-target.dto'

type RestDomainTarget = { type: 'box'; box: string; port: number }

type RestDomain = {
  name: string
  hostname: string
  url: string
  /** Where the name routes; null while the name is held but unbound. */
  target: RestDomainTarget | null
}

type RestDomainList = {
  domains: RestDomain[]
  limit: number
  used: number
  remaining: number
  min_length: number
}

function toRestDomain(domain: HeldDomain): RestDomain {
  return {
    name: domain.name,
    hostname: domain.hostname,
    url: domain.url,
    target:
      domain.boxId === null || domain.port === null ? null : { type: 'box', box: domain.boxId, port: domain.port },
  }
}

/**
 * Domains are the organization's, not a box's: they are listed and bound
 * here, by name, and a box is only what a name routes to. `{domain}` is a
 * platform name (`demo`) or a full hostname (`demo.apps.example`).
 */
// Spec-first surface (openapi/box.openapi.yaml), like the other REST controllers.
@Controller(['v1/domains', 'v1/:prefix/domains'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteDomainController {
  constructor(
    private readonly tunnelDomainService: TunnelDomainService,
    private readonly boxService: BoxService,
  ) {}

  /**
   * Every domain the organization holds, bound or not, with the allowance
   * they count against. An unbound name still occupies a slot, which is why
   * the list exists: it is how a caller finds a name to reuse.
   */
  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<RestDomainList> {
    const held = await this.tunnelDomainService.listHeld(authContext.organizationId)
    return {
      domains: held.domains.map(toRestDomain),
      limit: held.limit,
      used: held.used,
      remaining: held.remaining,
      min_length: held.minLength,
    }
  }

  /**
   * Route a domain to a box port, claiming the name if it is new. A name bound
   * to another of the organization's ports moves here; other names on this
   * port stay. The port is not declared public here: the name answers once
   * `POST …/network/tunnel` has declared it and the box allows inbound access,
   * in either order.
   */
  @Put(':domain/target')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async bind(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('domain') domain: string,
    @Body() target: DomainTargetDto,
  ): Promise<RestDomain> {
    // findOneByIdOrName already 404s for a missing/destroyed box.
    const box = await this.boxService.findOneByIdOrName(target.box, authContext.organizationId)
    return toRestDomain(await this.tunnelDomainService.bind(box, target.port, domain))
  }

  /**
   * Stop routing a domain and keep it for the organization. By name, not by
   * port: the name is the organization's, and the port it was bound to may be
   * gone. The port's public declaration is untouched.
   */
  @Delete(':domain/target')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.NO_CONTENT)
  async unbind(@AuthContext() authContext: OrganizationAuthContext, @Param('domain') domain: string): Promise<void> {
    await this.tunnelDomainService.unbind(authContext.organizationId, domain)
  }
}
