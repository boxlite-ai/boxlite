/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { isProxyContext } from '../../common/interfaces/proxy-context.interface'
import { isRegionProxyContext } from '../../common/interfaces/region-proxy.interface'

@Injectable()
export class BoxEndpointProxyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user
    if (user && (isProxyContext(user) || isRegionProxyContext(user))) return true
    throw new UnauthorizedException('Proxy credentials required')
  }
}
