/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, CanActivate, ExecutionContext, NotFoundException, ForbiddenException } from '@nestjs/common'
import { BoxService } from '../services/box.service'
import { BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { isRegionProxyContext, RegionProxyContext } from '../../common/interfaces/region-proxy.interface'
import {
  isRegionSSHGatewayContext,
  RegionSSHGatewayContext,
} from '../../common/interfaces/region-ssh-gateway.interface'

@Injectable()
export class RegionBoxAccessGuard implements CanActivate {
  constructor(private readonly boxService: BoxService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const boxId: string = request.params.boxId || request.params.id

    const authContext: BaseAuthContext = request.user

    if (!isRegionProxyContext(authContext) && !isRegionSSHGatewayContext(authContext)) {
      return false
    }

    try {
      const regionContext = authContext as RegionProxyContext | RegionSSHGatewayContext
      const boxRegionId = await this.boxService.getRegionId(boxId)
      if (boxRegionId !== regionContext.regionId) {
        throw new ForbiddenException(`Box region ID does not match region ${regionContext.role} region ID`)
      }
      return true
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        console.error(error)
      }
      throw new NotFoundException(`Box with ID or name ${boxId} not found`)
    }
  }
}
