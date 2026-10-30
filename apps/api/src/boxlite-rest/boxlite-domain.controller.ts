/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { HeldDomain, DomainService } from '../box/services/domain.service'
import { DomainTargetDto } from './dto/domain-target.dto'

type RestDomain = HeldDomain

type RestDomainList = {
  domains: RestDomain[]
  limit: number
  used: number
  remaining: number
  min_length: number
}

/**
 * Domains are the organization's, not a box's: they are listed and bound
 * here. Bind accepts a platform label (`demo`) or full hostname
 * (`demo.apps.example`); list and unbind identify domains by full hostname.
 */
// Spec-first surface (openapi/box.openapi.yaml), like the other REST controllers.
@Controller(['v1/domains', 'v1/:prefix/domains'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteDomainController {
  constructor(
    private readonly domainService: DomainService,
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
    const held = await this.domainService.listHeld(authContext.organizationId)
    return {
      domains: held.domains,
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
    if (target.type === 'app') {
      throw new BadRequestException({
        code: 'app_target_not_supported',
        message: 'App targets are reserved; App binding is not supported yet.',
      })
    }
    if (target.app !== undefined) {
      throw new BadRequestException('A Box target must not include an App reference')
    }
    // findOneByIdOrName already 404s for a missing/destroyed box.
    const box = await this.boxService.findOneByIdOrName(target.box!, authContext.organizationId)
    return this.domainService.bind(box, target.port!, domain)
  }

  /**
   * Stop routing a full hostname and keep it for the organization. By hostname, not by
   * port: the name is the organization's, and the port it was bound to may be
   * gone. The port's public declaration is untouched.
   */
  @Delete(':domain/target')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.NO_CONTENT)
  async unbind(@AuthContext() authContext: OrganizationAuthContext, @Param('domain') domain: string): Promise<void> {
    await this.domainService.unbind(authContext.organizationId, domain)
  }
}
