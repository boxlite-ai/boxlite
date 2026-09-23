/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole, RequiredSystemRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationController } from './organization.controller'

// suspend/unsuspend moved from @RequiredSystemRole(ADMIN) to
// @RequiredApiRole([ADMIN, 'billing']) so Commerce can call them with its own
// credential. SystemActionGuard checks RequiredSystemRole first and only
// falls back to RequiredApiRole when it is absent (system-action.guard.ts),
// so leaving the old decorator in place would have silently kept 'billing'
// locked out even after the auth strategy authenticated it correctly. These
// specs pin both halves of that swap directly against the real metadata,
// not a synthetic stand-in.
describe('OrganizationController suspend/unsuspend role metadata', () => {
  const reflector = new Reflector()

  it.each(['suspend', 'unsuspend'] as const)(
    'replaces RequiredSystemRole with RequiredApiRole([ADMIN, billing]) on %s',
    (method) => {
      const handler = OrganizationController.prototype[method]

      expect(reflector.get(RequiredSystemRole, handler)).toBeUndefined()
      expect(reflector.get(RequiredApiRole, handler)).toEqual([SystemRole.ADMIN, 'billing'])
    },
  )
})

describe('OrganizationController suspend/unsuspend, evaluated through the real guard', () => {
  function httpContext(request: Record<string, unknown>, method: 'suspend' | 'unsuspend'): ExecutionContext {
    return {
      getClass: () => OrganizationController,
      getHandler: () => OrganizationController.prototype[method],
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext
  }

  const guard = () => new SystemActionGuard(new Reflector())

  it.each(['suspend', 'unsuspend'] as const)('still admits an Admin caller to %s', async (method) => {
    const request = { user: { role: SystemRole.ADMIN } }

    await expect(guard().canActivate(httpContext(request, method))).resolves.toBe(true)
  })

  it.each(['suspend', 'unsuspend'] as const)('admits a billing caller to %s', async (method) => {
    const request = { user: { role: 'billing' } }

    await expect(guard().canActivate(httpContext(request, method))).resolves.toBe(true)
  })

  it.each(['suspend', 'unsuspend'] as const)('rejects an ordinary user from %s', async (method) => {
    const request = { user: { role: SystemRole.USER } }

    await expect(guard().canActivate(httpContext(request, method))).resolves.toBe(false)
  })
})
