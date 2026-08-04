/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { CommerceServiceGuard } from './commerce-service.guard'

function contextWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext
}

describe('CommerceServiceGuard', () => {
  const guard = new CommerceServiceGuard()

  it('allows a request whose user context has the commerce-service role', async () => {
    await expect(guard.canActivate(contextWithUser({ role: 'commerce-service' }))).resolves.toBe(true)
  })

  it('rejects a request authenticated as a different role', async () => {
    await expect(guard.canActivate(contextWithUser({ role: 'health-check' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('rejects a request with no user context at all', async () => {
    await expect(guard.canActivate(contextWithUser(undefined))).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
