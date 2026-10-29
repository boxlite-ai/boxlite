/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ThrottlerStorageService } from '@nestjs/throttler'
import { Redis } from 'ioredis'
import { OrganizationService } from '../../organization/services/organization.service'
import { SystemRole } from '../../user/enums/system-role.enum'
import { CustomHeaders } from '../constants/header.constants'
import { AuthenticatedRateLimitGuard } from './authenticated-rate-limit.guard'

function context(organizationHeader: string, verifiedContext: Record<string, unknown> = {}): ExecutionContext {
  const request = {
    headers: { authorization: 'Bearer same-token', [CustomHeaders.ORGANIZATION_ID.name]: organizationHeader },
    params: { organizationId: 'org-1' },
    user: {
      userId: 'user-1',
      role: SystemRole.USER,
      // JwtStrategy copies the header before organization authorization runs.
      organizationId: organizationHeader,
      ...verifiedContext,
    },
  }
  return {
    getClass: () => AuthenticatedRateLimitGuard,
    getHandler: () => AuthenticatedRateLimitGuard.prototype.canActivate,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ header: jest.fn() }) }),
  } as unknown as ExecutionContext
}

describe('AuthenticatedRateLimitGuard organization trust', () => {
  it('ignores unverified organization headers while preserving verified API key quotas', async () => {
    const storage = new ThrottlerStorageService()
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
    const organizations = {
      findOne: jest.fn().mockResolvedValue({ authenticatedRateLimit: 1, authenticatedRateLimitTtlSeconds: 60 }),
    }
    const guard = new AuthenticatedRateLimitGuard(
      [{ name: 'authenticated', ttl: 60000, limit: 2 }],
      storage,
      new Reflector(),
      redis as unknown as Redis,
      organizations as unknown as OrganizationService,
    )

    try {
      await guard.onModuleInit()
      await expect(guard.canActivate(context('header-org-a'))).resolves.toBe(true)
      await expect(guard.canActivate(context('header-org-b'))).resolves.toBe(true)
      await expect(guard.canActivate(context('header-org-c'))).rejects.toMatchObject({ status: 429 })
      expect(redis.get).not.toHaveBeenCalled()
      expect(organizations.findOne).not.toHaveBeenCalled()

      const apiKeyContext = { organizationId: 'org-1', apiKey: { organizationId: 'org-1' } }
      await expect(guard.canActivate(context('header-org-a', apiKeyContext))).resolves.toBe(true)
      await expect(guard.canActivate(context('header-org-b', apiKeyContext))).rejects.toMatchObject({ status: 429 })
      expect(organizations.findOne.mock.calls).toEqual([['org-1'], ['org-1']])
    } finally {
      storage.onApplicationShutdown()
    }
  })
})
