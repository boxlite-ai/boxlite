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
  let guard: AuthenticatedRateLimitGuard
  let storage: ThrottlerStorageService
  let redis: { get: jest.Mock; set: jest.Mock }
  let organizations: { findOne: jest.Mock }

  beforeEach(async () => {
    storage = new ThrottlerStorageService()
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
    organizations = {
      findOne: jest.fn().mockResolvedValue({ authenticatedRateLimit: 1, authenticatedRateLimitTtlSeconds: 60 }),
    }
    guard = new AuthenticatedRateLimitGuard(
      [{ name: 'authenticated', ttl: 60000, limit: 2 }],
      storage,
      new Reflector(),
      redis as unknown as Redis,
      organizations as unknown as OrganizationService,
    )
    await guard.onModuleInit()
  })

  afterEach(() => storage.onApplicationShutdown())

  it('reaches one user threshold while the token and path stay fixed and organization headers rotate', async () => {
    await expect(guard.canActivate(context('header-org-a'))).resolves.toBe(true)
    await expect(guard.canActivate(context('header-org-b'))).resolves.toBe(true)
    await expect(guard.canActivate(context('header-org-c'))).rejects.toMatchObject({ status: 429 })
  })

  it('does not look up custom organization limits from an unvalidated JWT header', async () => {
    await guard.canActivate(context('header-org-a'))

    expect(redis.get).not.toHaveBeenCalled()
    expect(organizations.findOne).not.toHaveBeenCalled()
  })

  it.each([
    ['validated organization', { organizationId: 'org-1', organization: { id: 'org-1' } }],
    ['verified API key', { organizationId: 'org-1', apiKey: { organizationId: 'org-1' } }],
  ])('shares the custom organization limit from a %s', async (_name, verifiedContext) => {
    await expect(guard.canActivate(context('header-org-a', verifiedContext))).resolves.toBe(true)
    await expect(guard.canActivate(context('header-org-b', verifiedContext))).rejects.toMatchObject({ status: 429 })

    expect(organizations.findOne.mock.calls).toEqual([['org-1'], ['org-1']])
  })
})
