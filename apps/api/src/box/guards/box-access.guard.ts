/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, CanActivate, ExecutionContext, NotFoundException, ForbiddenException } from '@nestjs/common'
import { BoxService } from '../services/box.service'
import { OrganizationAuthContext, BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { isRunnerContext, RunnerContext } from '../../common/interfaces/runner-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { isProxyContext } from '../../common/interfaces/proxy-context.interface'
import { isSshGatewayContext } from '../../common/interfaces/ssh-gateway-context.interface'
import { isRegionProxyContext, RegionProxyContext } from '../../common/interfaces/region-proxy.interface'
import {
  isRegionSSHGatewayContext,
  RegionSSHGatewayContext,
} from '../../common/interfaces/region-ssh-gateway.interface'

@Injectable()
export class BoxAccessGuard implements CanActivate {
  constructor(private readonly boxService: BoxService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    // TODO: remove deprecated request.params.workspaceId param once we remove the deprecated workspace controller
    const boxIdOrName: string =
      request.params.boxIdOrName || request.params.boxId || request.params.id || request.params.workspaceId

    // TODO: initialize authContext safely
    const authContext: BaseAuthContext = request.user

    try {
      switch (true) {
        case isRunnerContext(authContext): {
          // For runner authentication, verify that the runner ID matches the box's runner ID
          const runnerContext = authContext as RunnerContext
          const boxRunnerId = await this.boxService.getRunnerId(boxIdOrName)
          if (boxRunnerId !== runnerContext.runnerId) {
            throw new ForbiddenException('Runner ID does not match box runner ID')
          }
          break
        }
        case isRegionProxyContext(authContext):
        case isRegionSSHGatewayContext(authContext): {
          // For region proxy/ssh gateway authentication, verify that the runner's region ID matches the region ID
          const regionContext = authContext as RegionProxyContext | RegionSSHGatewayContext
          const boxRegionId = await this.boxService.getRegionId(boxIdOrName)
          if (boxRegionId !== regionContext.regionId) {
            throw new ForbiddenException(`Box region ID does not match region ${regionContext.role} region ID`)
          }
          break
        }
        case isProxyContext(authContext):
        case isSshGatewayContext(authContext):
          return true
        default: {
          // For user/organization authentication, check organization access
          const orgAuthContext = authContext as OrganizationAuthContext
          const boxOrganizationId = await this.boxService.getOrganizationId(boxIdOrName, orgAuthContext.organizationId)
          if (orgAuthContext.role !== SystemRole.ADMIN && boxOrganizationId !== orgAuthContext.organizationId) {
            throw new ForbiddenException('Request organization ID does not match resource organization ID')
          }
        }
      }
      return true
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        console.error(error)
      }
      throw new NotFoundException(`Box with ID or name ${boxIdOrName} not found`)
    }
  }
}
