/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common'
import { SavedImageService } from '../services/saved-image.service'
import {
  BaseAuthContext,
  isOrganizationAuthContext,
  OrganizationAuthContext,
} from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { SavedImage } from '../entities/saved-image.entity'
import { isSshGatewayContext } from '../../common/interfaces/ssh-gateway-context.interface'
import { isProxyContext } from '../../common/interfaces/proxy-context.interface'
import { isRegionProxyContext, RegionProxyContext } from '../../common/interfaces/region-proxy.interface'
import {
  isRegionSSHGatewayContext,
  RegionSSHGatewayContext,
} from '../../common/interfaces/region-ssh-gateway.interface'

@Injectable()
export class SavedImageReadAccessGuard implements CanActivate {
  constructor(private readonly savedImageService: SavedImageService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const savedImageId: string = request.params.savedImageId || request.params.id

    let savedImage: SavedImage

    const authContext: BaseAuthContext = request.user

    try {
      savedImage = await this.savedImageService.getSavedImage(savedImageId)
    } catch {
      if (!isOrganizationAuthContext(authContext)) {
        throw new NotFoundException(`SavedImage with ID ${savedImageId} not found`)
      }

      savedImage = await this.savedImageService.getSavedImageByName(savedImageId, authContext.organizationId)
    }

    try {
      switch (true) {
        case isRegionProxyContext(authContext):
        case isRegionSSHGatewayContext(authContext): {
          const regionContext = authContext as RegionProxyContext | RegionSSHGatewayContext
          const isAvailable = await this.savedImageService.isAvailableInRegion(savedImage.id, regionContext.regionId)
          if (!isAvailable) {
            throw new NotFoundException(`SavedImage is not available in region ${regionContext.regionId}`)
          }
          break
        }
        case isProxyContext(authContext):
        case isSshGatewayContext(authContext):
          break
        default: {
          const orgAuthContext = authContext as OrganizationAuthContext
          if (
            orgAuthContext.role !== SystemRole.ADMIN &&
            savedImage.organizationId !== orgAuthContext.organizationId &&
            !savedImage.general
          ) {
            throw new ForbiddenException('Request organization ID does not match resource organization ID')
          }
        }
      }

      request.savedImage = savedImage

      return true
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        console.error(error)
      }
      throw new NotFoundException(`SavedImage with ID or name ${savedImageId} not found`)
    }
  }
}
