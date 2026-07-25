/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { BoxAccessGrantService } from '../services/box-access-grant.service'
import { BoxAccessGuard } from './box-access.guard'

// Design section 6.3: SSH-credential creation accepts EITHER the caller's
// normal account authorization OR a previously issued box-scoped app key via
// `X-BoxLite-App-Key`, and rejects requests presenting both (identity
// ambiguity). The app-key path has no organization session, so it cannot
// reuse `OrganizationResourceActionGuard`/`BoxAccessGuard` -- this guard
// fully owns authorization for both paths rather than composing with them
// unconditionally, matching how `request.appKeyGrant` (set here) or
// `request.user` (set by the org path) get consumed downstream.
@Injectable()
export class SshCredentialAuthGuard implements CanActivate {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly boxAccessGrantService: BoxAccessGrantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const appKeyHeaderName = CustomHeaders.APP_KEY.name.toLowerCase()
    const appKey: string | undefined = request.headers[appKeyHeaderName]
    const hasAccountAuth = Boolean(request.headers['authorization'])

    if (appKey && hasAccountAuth) {
      throw new UnauthorizedException('Provide either account authorization or X-BoxLite-App-Key, not both')
    }

    if (appKey) {
      request.appKeyGrant = await this.boxAccessGrantService.findActiveByAppKey(appKey)
      return true
    }

    for (const GuardClass of [CombinedAuthGuard, OrganizationResourceActionGuard, BoxAccessGuard]) {
      const guard = this.moduleRef.get(GuardClass, { strict: false })
      if (!(await guard.canActivate(context))) {
        return false
      }
    }
    return true
  }
}
