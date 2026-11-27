/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

jest.mock('../box/services/runner.service', () => ({ RunnerService: class RunnerService {} }))
jest.mock('../region/services/region.service', () => ({ RegionService: class RegionService {} }))

import { ApiKeyStrategy } from './api-key.strategy'

describe('ApiKeyStrategy singleflight', () => {
  it('coalesces the complete validation for concurrent uses of one user token', async () => {
    let release!: (value: Record<string, unknown>) => void
    const pendingApiKey = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    const apiKeyService = {
      getApiKeyByValue: jest.fn().mockReturnValue(pendingApiKey),
      updateLastUsedAt: jest.fn().mockResolvedValue(undefined),
    }
    const userService = {
      findOne: jest.fn().mockResolvedValue({ id: 'owner', email: 'owner@example.test', role: 'user' }),
    }
    const strategy = new ApiKeyStrategy(
      { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') } as any,
      apiKeyService as any,
      userService as any,
      { get: jest.fn().mockReturnValue(undefined) } as any,
      { findByApiKey: jest.fn() } as any,
      { findOneByProxyApiKey: jest.fn() } as any,
    )

    const first = strategy.validate('same-token')
    const second = strategy.validate('same-token')
    release({
      userId: 'owner',
      organizationId: 'org-1',
      name: 'key',
      permissions: ['write:boxes'],
      expiresAt: null,
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ userId: 'owner' }),
      expect.objectContaining({ userId: 'owner' }),
    ])
    expect(apiKeyService.getApiKeyByValue).toHaveBeenCalledTimes(1)
    expect(userService.findOne).toHaveBeenCalledTimes(1)
    expect(apiKeyService.updateLastUsedAt).toHaveBeenCalledTimes(1)
  })
})
