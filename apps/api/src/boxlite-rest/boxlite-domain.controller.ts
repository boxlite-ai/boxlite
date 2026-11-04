/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Audit, AUDIT_TARGET_ID } from '../audit/decorators/audit.decorator'
import { Request } from 'express'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import {
  OrganizationResourceActionGuard,
  hasOrganizationResourcePermissions,
} from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { HeldDomain, DomainService } from '../box/services/domain.service'
import { DomainTargetDto } from './dto/domain-target.dto'
import { ClaimDomainDto } from './dto/claim-domain.dto'

type RestDomain = HeldDomain

type RestDomainList = {
  domains: RestDomain[]
  limit: number
  used: number
  remaining: number
  min_length: number
  domain_suffix: string | null
}

/**
 * Domains are the organization's, not a box's: they are listed and bound
 * here. Claim accepts a short name; bind and unbind require an owned full hostname.
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
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<RestDomainList> {
    this.requireAny(
      authContext,
      OrganizationResourcePermission.READ_APPS,
      OrganizationResourcePermission.WRITE_APPS,
      OrganizationResourcePermission.WRITE_BOXES,
    )
    const held = await this.domainService.listHeld(authContext.organizationId)
    return {
      domains: held.domains,
      limit: held.limit,
      used: held.used,
      remaining: held.remaining,
      min_length: held.minLength,
      domain_suffix: held.domainSuffix,
    }
  }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.DOMAIN,
    targetIdFromResult: (result) => result.hostname,
  })
  async claim(@AuthContext() authContext: OrganizationAuthContext, @Body() input: ClaimDomainDto): Promise<RestDomain> {
    this.requireAny(authContext, OrganizationResourcePermission.WRITE_APPS, OrganizationResourcePermission.WRITE_BOXES)
    return this.domainService.claim(authContext.organizationId, input.name)
  }

  /**
   * Route an owned full hostname to a Box port or App environment. A name bound
   * to another of the organization's ports moves here; other names on this
   * port stay. The port is not declared public here: the name answers once
   * `POST …/network/tunnel` has declared it and the box allows inbound access,
   * in either order.
   */
  @Put(':domain/target')
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.DOMAIN,
    targetIdFromRequest: (req) => req.params.domain,
    targetIdFromResult: (result) => result.hostname,
  })
  async bind(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('domain') domain: string,
    @Body() target: DomainTargetDto,
  ): Promise<RestDomain> {
    if (target.type === 'app') {
      if (target.box !== undefined || target.port !== undefined)
        throw new BadRequestException('An App target must not include a Box or port')
      this.requireAny(authContext, OrganizationResourcePermission.WRITE_APPS)
      await this.requireCurrentTargetPermission(authContext, domain)
      return this.domainService.bindApp(authContext.organizationId, target.app!, target.environment ?? 'main', domain)
    }
    if (target.app !== undefined || target.environment !== undefined) {
      throw new BadRequestException('A Box target must not include an App or environment reference')
    }
    this.requireAny(authContext, OrganizationResourcePermission.WRITE_BOXES)
    await this.requireCurrentTargetPermission(authContext, domain)
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.DOMAIN,
    targetIdFromRequest: (req) => req.params.domain,
  })
  async unbind(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('domain') domain: string,
    @Req() request?: Request,
  ): Promise<void> {
    this.requireAny(authContext, OrganizationResourcePermission.WRITE_APPS, OrganizationResourcePermission.WRITE_BOXES)
    await this.requireCurrentTargetPermission(authContext, domain)
    const hostname = await this.domainService.unbind(authContext.organizationId, domain)
    if (request) request[AUDIT_TARGET_ID] = hostname
  }

  private requireAny(auth: OrganizationAuthContext, ...permissions: OrganizationResourcePermission[]): void {
    if (auth.apiKey?.cloudAppId) throw new ForbiddenException('App keys manage domains through their App')
    if (!permissions.some((permission) => hasOrganizationResourcePermissions(auth, [permission]))) {
      throw new ForbiddenException('You do not have permission to manage this domain target')
    }
  }

  private async requireCurrentTargetPermission(auth: OrganizationAuthContext, domain: string): Promise<void> {
    const held = await this.domainService.owned(auth.organizationId, domain)
    if (held.target)
      this.requireAny(
        auth,
        held.target.type === 'app'
          ? OrganizationResourcePermission.WRITE_APPS
          : OrganizationResourcePermission.WRITE_BOXES,
      )
  }
}
