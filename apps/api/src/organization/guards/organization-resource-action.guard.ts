/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, Injectable, ExecutionContext, Logger, Type } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { OrganizationAccessGuard } from './organization-access.guard'
import { RequiredOrganizationResourcePermissions } from '../decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { isRunnerContext } from '../../common/interfaces/runner-context.interface'
import { OR_GUARD_INNER_GUARDS } from '../../auth/or.guard'

const RUNNER_COMPATIBLE_RESOURCE_GUARD_NAMES = new Set(['RunnerAuthGuard', 'BoxAccessGuard'])

@Injectable()
export class OrganizationResourceActionGuard extends OrganizationAccessGuard {
  protected readonly logger = new Logger(OrganizationResourceActionGuard.name)

  constructor(
    organizationService: OrganizationService,
    organizationUserService: OrganizationUserService,
    private readonly reflector: Reflector,
  ) {
    super(organizationService, organizationUserService)
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    if (isRunnerContext(request.user) && this.handlerAllowsRunnerResourceAccess(context)) {
      return true
    }

    const canActivate = await super.canActivate(context)

    // TODO: initialize authContext safely
    const authContext: OrganizationAuthContext = request.user
    if (!authContext) {
      return false
    }

    if (authContext.role === SystemRole.ADMIN) {
      return true
    }

    if (!canActivate) {
      return false
    }

    if (!authContext.organizationUser) {
      return false
    }

    if (authContext.organizationUser.role === OrganizationMemberRole.OWNER && !authContext.apiKey) {
      return true
    }

    const requiredPermissions =
      this.reflector.get(RequiredOrganizationResourcePermissions, context.getHandler()) ||
      this.reflector.get(RequiredOrganizationResourcePermissions, context.getClass())

    if (!requiredPermissions) {
      return true
    }

    const assignedPermissions = authContext.apiKey
      ? new Set(authContext.apiKey.permissions)
      : new Set(authContext.organizationUser.assignedRoles.flatMap((role) => role.permissions))

    return requiredPermissions.every((permission) => assignedPermissions.has(permission))
  }

  private handlerAllowsRunnerResourceAccess(context: ExecutionContext): boolean {
    const guards =
      this.reflector.getAllAndMerge<Array<unknown>>(GUARDS_METADATA, [context.getHandler(), context.getClass()]) ?? []
    return guards.some((guard) => this.guardAllowsRunnerResourceAccess(guard))
  }

  private guardAllowsRunnerResourceAccess(guard: unknown): boolean {
    if (guard === RunnerAuthGuard) {
      return true
    }

    const innerGuards = (guard as { [OR_GUARD_INNER_GUARDS]?: Type<CanActivate>[] })?.[OR_GUARD_INNER_GUARDS]
    if (innerGuards?.some((innerGuard) => this.guardAllowsRunnerResourceAccess(innerGuard))) {
      return true
    }

    return RUNNER_COMPATIBLE_RESOURCE_GUARD_NAMES.has(this.guardName(guard))
  }

  private guardName(guard: unknown): string {
    return typeof guard === 'function' ? guard.name : ''
  }
}
