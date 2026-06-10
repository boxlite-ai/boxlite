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
import { OrganizationResourceActionGuard } from './organization-resource-action.guard'

class SandboxAccessGuard {
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

  it('lets runner-authenticated sandbox resource routes defer access checks to SandboxAccessGuard', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()
    const handler = function sandboxHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [SandboxAccessGuard], handler)

    const request = {
      params: { sandboxId: 'sandbox-1' },
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

  it('unwraps OrGuard metadata so runner activity updates reach SandboxAccessGuard', async () => {
    const { guard, organizationService, organizationUserService } = createGuard()
    const handler = function runnerActivityHandler() {}
    Reflect.defineMetadata(GUARDS_METADATA, [OrGuard([SandboxAccessGuard])], handler)

    const request = {
      params: { sandboxId: 'sandbox-1' },
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
