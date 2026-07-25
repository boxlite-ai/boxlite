/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, Injectable, ExecutionContext, Logger, Type } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { OrganizationAccessGuard } from './organization-access.guard'
import {
  FailClosedOnMissingOrganizationResourcePermissions,
  RequiredOrganizationResourcePermissions,
} from '../decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { isRunnerContext } from '../../common/interfaces/runner-context.interface'
import { OR_GUARD_INNER_GUARDS } from '../../auth/or.guard'

const RUNNER_COMPATIBLE_RESOURCE_GUARD_NAMES = new Set(['RunnerAuthGuard', 'BoxAccessGuard'])

export function hasRequiredOrganizationResourcePermissions(
  authContext: OrganizationAuthContext,
  requiredPermissions: OrganizationResourcePermission[],
): boolean {
  if (authContext.apiKey) {
    if (!authContext.organizationUser) {
      return false
    }
    return hasEveryRequiredPermission(authContext.apiKey.permissions, requiredPermissions)
  }

  if (authContext.role === SystemRole.ADMIN) {
    return true
  }

  if (!authContext.organizationUser) {
    return false
  }

  if (authContext.organizationUser.role === OrganizationMemberRole.OWNER) {
    return true
  }

  const permissions = authContext.organizationUser.assignedRoles?.flatMap((role) => role.permissions)
  return hasEveryRequiredPermission(permissions, requiredPermissions)
}

function hasEveryRequiredPermission(
  permissions: OrganizationResourcePermission[] | undefined,
  requiredPermissions: OrganizationResourcePermission[],
): boolean {
  if (requiredPermissions.length === 0) {
    return true
  }
  if (!Array.isArray(permissions)) {
    return false
  }

  const assignedPermissions = new Set(permissions)
  return requiredPermissions.every((permission) => assignedPermissions.has(permission))
}

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

    const requiredPermissions =
      this.reflector.get(RequiredOrganizationResourcePermissions, context.getHandler()) ||
      this.reflector.get(RequiredOrganizationResourcePermissions, context.getClass())

    if (!requiredPermissions) {
      const failClosed =
        this.reflector.get(FailClosedOnMissingOrganizationResourcePermissions, context.getHandler()) ||
        this.reflector.get(FailClosedOnMissingOrganizationResourcePermissions, context.getClass())
      if (failClosed) {
        return false
      }
    }

    if (authContext.role === SystemRole.ADMIN && !authContext.apiKey) {
      return true
    }

    if (!canActivate) {
      return false
    }

    return requiredPermissions ? hasRequiredOrganizationResourcePermissions(authContext, requiredPermissions) : true
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
