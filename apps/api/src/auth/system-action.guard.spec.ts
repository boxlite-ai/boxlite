/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, Type } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RequiredApiRole } from '../common/decorators/required-role.decorator'
import { SystemRole } from '../user/enums/system-role.enum'
import { SystemActionGuard } from './system-action.guard'

function httpContext(request: Record<string, unknown>, controllerClass: Type<unknown>): ExecutionContext {
  return {
    getClass: () => controllerClass,
    getHandler: () => function handler() {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext
}

describe('SystemActionGuard', () => {
  function createGuard() {
    return new SystemActionGuard(new Reflector())
  }

  it('allows Admin API callers through Admin-only routes', async () => {
    class AdminOnlyController {}
    RequiredApiRole([SystemRole.ADMIN])(AdminOnlyController)

    const request = {
      user: {
        role: SystemRole.ADMIN,
      },
    }

    await expect(createGuard().canActivate(httpContext(request, AdminOnlyController))).resolves.toBe(true)
  })

  it('rejects ordinary users from Admin-only routes', async () => {
    class AdminOnlyController {}
    RequiredApiRole([SystemRole.ADMIN])(AdminOnlyController)

    const request = {
      user: {
        role: SystemRole.USER,
      },
    }

    await expect(createGuard().canActivate(httpContext(request, AdminOnlyController))).resolves.toBe(false)
  })

  it('allows routes without a required role to continue to downstream guards or handlers', async () => {
    class UnscopedController {}

    const request = {
      user: {
        role: SystemRole.USER,
      },
    }

    await expect(createGuard().canActivate(httpContext(request, UnscopedController))).resolves.toBe(true)
  })
})
