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
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationAccessGuard } from './organization-access.guard'

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext
}

function createGuard() {
  const organization = { id: 'org-123' }
  const organizationUser = { organizationId: 'org-123', userId: 'user-1' }
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  }
  const organizationService = {
    findOne: jest.fn().mockResolvedValue(organization),
  }
  const organizationUserService = {
    findOne: jest.fn().mockResolvedValue(organizationUser),
  }

  const guard = new OrganizationAccessGuard(organizationService as any, organizationUserService as any)
  ;(guard as any).redis = redis

  return {
    guard,
    mocks: { organizationService, organizationUserService, redis },
  }
}

describe('OrganizationAccessGuard', () => {
  it('reads cached exec timeouts and refreshes misses with a ten-second TTL', async () => {
    const { guard, mocks } = createGuard()
    const stored = { id: 'org-123', defaultExecTimeoutSeconds: 0 }
    mocks.organizationService.findOne.mockResolvedValue(stored)
    mocks.redis.get.mockResolvedValueOnce(JSON.stringify({ ...stored, defaultExecTimeoutSeconds: 1800 }))
    for (const expected of [1800, 0]) {
      const request = { params: { organizationId: stored.id }, user: { role: SystemRole.ADMIN, userId: 'user-1' } }
      await expect(guard.canActivate(httpContext(request))).resolves.toBe(true)
      expect(request.user).toMatchObject({ organization: { defaultExecTimeoutSeconds: expected } })
    }
    expect(mocks.organizationService.findOne).toHaveBeenCalledTimes(1)
    expect(mocks.redis.set).toHaveBeenCalledWith('organization:org-123', JSON.stringify(stored), 'EX', 10)
  })

  it('resolves the legacy REST default prefix to the authenticated API-key organization', async () => {
    const { guard, mocks } = createGuard()
    const request = {
      params: { prefix: 'default' },
      user: {
        userId: 'user-1',
        email: 'user@example.com',
        role: SystemRole.USER,
        organizationId: 'org-123',
        apiKey: { organizationId: 'org-123' },
      },
    }

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true)

    expect(mocks.organizationService.findOne).toHaveBeenCalledWith('org-123')
    expect(mocks.organizationUserService.findOne).toHaveBeenCalledWith('org-123', 'user-1')
    expect(request.user).toMatchObject({
      organizationId: 'org-123',
      organization: { id: 'org-123' },
      organizationUser: { organizationId: 'org-123', userId: 'user-1' },
    })
  })

  it('still rejects explicit organization prefixes that do not match the API key', async () => {
    const { guard, mocks } = createGuard()
    const request = {
      params: { prefix: 'other-org' },
      user: {
        userId: 'user-1',
        email: 'user@example.com',
        role: SystemRole.USER,
        organizationId: 'org-123',
        apiKey: { organizationId: 'org-123' },
      },
    }

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(false)

    expect(mocks.organizationService.findOne).not.toHaveBeenCalled()
    expect(mocks.organizationUserService.findOne).not.toHaveBeenCalled()
  })
})
