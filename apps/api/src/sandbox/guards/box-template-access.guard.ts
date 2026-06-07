/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common'
import { BoxTemplateService } from '../services/box-template.service'
import {
  BaseAuthContext,
  isOrganizationAuthContext,
  OrganizationAuthContext,
} from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BoxTemplate } from '../entities/box-template.entity'
import { isSshGatewayContext } from '../../common/interfaces/ssh-gateway-context.interface'
import { isProxyContext } from '../../common/interfaces/proxy-context.interface'
import { isRegionProxyContext, RegionProxyContext } from '../../common/interfaces/region-proxy.interface'
import {
  isRegionSSHGatewayContext,
  RegionSSHGatewayContext,
} from '../../common/interfaces/region-ssh-gateway.interface'

@Injectable()
export class BoxTemplateAccessGuard implements CanActivate {
  constructor(private readonly boxTemplateService: BoxTemplateService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const templateId: string = request.params.templateId || request.params.id

    let template: BoxTemplate

    // TODO: initialize authContext safely
    const authContext: BaseAuthContext = request.user

    try {
      template = await this.boxTemplateService.getBoxTemplate(templateId)
    } catch {
      if (!isOrganizationAuthContext(authContext)) {
        throw new NotFoundException(`BoxTemplate with ID ${templateId} not found`)
      }

      // If not found by ID, try by name
      template = await this.boxTemplateService.getBoxTemplateByName(templateId, authContext.organizationId)
    }

    try {
      switch (true) {
        case isRegionProxyContext(authContext):
        case isRegionSSHGatewayContext(authContext): {
          // For region proxy/ssh gateway authentication, verify that the runner's region ID matches the region ID
          const regionContext = authContext as RegionProxyContext | RegionSSHGatewayContext
          const isAvailable = await this.boxTemplateService.isAvailableInRegion(template.id, regionContext.regionId)
          if (!isAvailable) {
            throw new NotFoundException(`BoxTemplate is not available in region ${regionContext.regionId}`)
          }
          break
        }
        case isProxyContext(authContext):
        case isSshGatewayContext(authContext):
          break
        default: {
          // For user/organization authentication, check organization access
          const orgAuthContext = authContext as OrganizationAuthContext
          if (orgAuthContext.role !== SystemRole.ADMIN && template.organizationId !== orgAuthContext.organizationId) {
            throw new ForbiddenException('Request organization ID does not match resource organization ID')
          }
        }
      }

      request.template = template

      return true
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        console.error(error)
      }
      throw new NotFoundException(`BoxTemplate with ID or name ${templateId} not found`)
    }
  }
}
