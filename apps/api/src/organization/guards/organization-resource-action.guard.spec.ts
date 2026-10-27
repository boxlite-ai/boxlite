/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

import { ExecutionContext } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { OrGuard } from '../../auth/or.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RequiredOrganizationResourcePermissions } from '../decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'
import {
  OrganizationResourceActionGuard,
  hasOrganizationResourcePermissions,
} from './organization-resource-action.guard'

class BoxAccessGuard {
  canActivate() {
    return true
  }
}

function httpContext(request: Record<string, unknown>, handler = function handler() {}): ExecutionContext {
  return {
    getClass: () => class Controller {},
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext
}

function createGuard() {
  const reflector = new Reflector()
  const organizationService = { findOne: jest.fn() }
  const organizationUserService = { findOne: jest.fn() }
  const guard = new OrganizationResourceActionGuard(
    organizationService as never,
    organizationUserService as never,
    reflector,
  )
  ;(guard as any).redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  }

  return {
    guard,
    organizationService,
    organizationUserService,
  }
}

describe('OrganizationResourceActionGuard', () => {
  it('lets runner-authenticated runner routes bypass organization context resolution', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()
    const handler = function runnerHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [RunnerAuthGuard], handler)

    const request = {
      params: {},
      user: {
        role: 'runner',
        runnerId: 'runner-1',
        runner: { id: 'runner-1' },
      },
    }

    await expect(guard.canActivate(httpContext(request, handler))).resolves.toBe(true)

    expect(organizationService.findOne).not.toHaveBeenCalled()
    expect(organizationUserService.findOne).not.toHaveBeenCalled()
  })

  it('lets runner-authenticated box resource routes defer access checks to BoxAccessGuard', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()
    const handler = function boxHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [BoxAccessGuard], handler)

    const request = {
      params: { boxId: 'box-1' },
      user: {
        role: 'runner',
        runnerId: 'runner-1',
        runner: { id: 'runner-1' },
      },
    }

    await expect(guard.canActivate(httpContext(request, handler))).resolves.toBe(true)

    expect(organizationService.findOne).not.toHaveBeenCalled()
    expect(organizationUserService.findOne).not.toHaveBeenCalled()
  })

  // The exemption is keyed on the role first, the guard second. A human context
  // on a BoxAccessGuard route — the one the runner case above is waved through —
  // must not inherit that pass, or declaring BoxAccessGuard would open every box
  // route to any authenticated user. The organization lookup is the proof: the
  // bypass returns before it, so reaching it means the request fell through to
  // the normal organization check.
  it('does not let a non-machine user inherit a machine role exemption', async () => {
    const { guard, organizationService } = createGuard()
    const handler = function boxHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [BoxAccessGuard], handler)

    const request = {
      params: { boxId: 'box-1' },
      user: {
        role: 'user',
        userId: 'user-1',
        organizationId: 'org-1',
      },
    }

    await expect(guard.canActivate(httpContext(request, handler))).resolves.toBe(false)

    expect(organizationService.findOne).toHaveBeenCalledWith('org-1')
  })

  it('unwraps OrGuard metadata so runner activity updates reach BoxAccessGuard', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()
    const handler = function runnerActivityHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [OrGuard([BoxAccessGuard])], handler)

    const request = {
      params: { boxId: 'box-1' },
      user: {
        role: 'runner',
        runnerId: 'runner-1',
        runner: { id: 'runner-1' },
      },
    }

    await expect(guard.canActivate(httpContext(request, handler))).resolves.toBe(true)

    expect(organizationService.findOne).not.toHaveBeenCalled()
    expect(organizationUserService.findOne).not.toHaveBeenCalled()
  })

  it('does not bypass organization context for runner users on non-runner routes', async () => {
    const { guard, organizationService } = createGuard()
    const request = {
      params: {},
      user: {
        role: 'runner',
        runnerId: 'runner-1',
        runner: { id: 'runner-1' },
      },
    }

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(false)

    expect(organizationService.findOne).not.toHaveBeenCalled()
  })

  it('falls through to the organization guard when authentication did not populate a user', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()

    await expect(guard.canActivate(httpContext({ params: {} }))).resolves.toBe(false)

    expect(organizationService.findOne).not.toHaveBeenCalled()
    expect(organizationUserService.findOne).not.toHaveBeenCalled()
  })
})

describe('OrganizationResourceActionGuard resource permissions', () => {
  const { WRITE_BOXES } = OrganizationResourcePermission

  function writeBoxesRoute() {
    const handler = function writeBoxesHandler() {}
    Reflect.defineMetadata(RequiredOrganizationResourcePermissions.KEY, [WRITE_BOXES], handler)
    return handler
  }

  function ownerRequest(apiKey?: { permissions: OrganizationResourcePermission[] }) {
    return {
      params: {},
      user: {
        role: 'user',
        userId: 'user-1',
        organizationId: 'org-1',
        ...(apiKey ? { apiKey: { organizationId: 'org-1', ...apiKey } } : {}),
      },
    }
  }

  function memberOf(role: 'owner' | 'member') {
    const { guard, organizationService, organizationUserService } = createGuard()
    organizationService.findOne.mockResolvedValue({ id: 'org-1' })
    organizationUserService.findOne.mockResolvedValue({ role, assignedRoles: [] })
    return guard
  }

  // An owner's key is bounded by the permissions it carries, not widened by its owner.
  it('bounds an owner API key by its own permissions on a tagged route', async () => {
    const route = writeBoxesRoute()

    await expect(memberOf('owner').canActivate(httpContext(ownerRequest({ permissions: [] }), route))).resolves.toBe(
      false,
    )
    await expect(
      memberOf('owner').canActivate(httpContext(ownerRequest({ permissions: [WRITE_BOXES] }), route)),
    ).resolves.toBe(true)
  })

  it('admits an interactive owner without an API key on a tagged route', async () => {
    await expect(memberOf('owner').canActivate(httpContext(ownerRequest(), writeBoxesRoute()))).resolves.toBe(true)
  })

  // A system admin is admitted before the organization result is consulted, so an
  // unresolvable organization does not lock it out.
  it('admits a system admin even when its organization cannot be resolved', async () => {
    const { guard, organizationService } = createGuard()
    organizationService.findOne.mockResolvedValue(null)
    const request = { params: {}, user: { role: 'admin', userId: 'admin-1', organizationId: 'missing-org' } }

    await expect(guard.canActivate(httpContext(request, writeBoxesRoute()))).resolves.toBe(true)
  })
})

describe('hasOrganizationResourcePermissions', () => {
  const { WRITE_BOXES } = OrganizationResourcePermission

  it('refuses a non-admin caller with no organization membership', () => {
    expect(hasOrganizationResourcePermissions({ role: 'user' } as never, [WRITE_BOXES])).toBe(false)
  })

  it('treats a member without an assigned-role list as holding nothing', () => {
    const subject = { role: 'user', organizationUser: { role: 'member' } } as never

    expect(hasOrganizationResourcePermissions(subject, [WRITE_BOXES])).toBe(false)
  })
})
