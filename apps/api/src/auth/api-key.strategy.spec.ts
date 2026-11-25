/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('../box/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('../region/services/region.service', () => ({
  RegionService: class RegionService {},
}))

import { ApiKeyStrategy } from './api-key.strategy'
import { generateApiKeyHash } from '../common/utils/api-key'

const jwtToken = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJib3hsaXRlIn0.signature'

function createStrategy() {
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn(),
  }
  const apiKeyService = {
    getApiKeyByValue: jest.fn().mockRejectedValue(new Error('not found')),
    findWithCurrentOwner: jest.fn(),
    updateLastUsedAt: jest.fn(),
  }
  const userService = {
    findOne: jest.fn(),
  }
  const configService = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn(() => {
      throw new Error('missing config')
    }),
  }
  const runnerService = {
    findByApiKey: jest.fn().mockResolvedValue(null),
  }
  const regionService = {
    findOneByProxyApiKey: jest.fn().mockResolvedValue(null),
  }

  return {
    strategy: new ApiKeyStrategy(
      redis as any,
      apiKeyService as any,
      userService as any,
      configService as any,
      runnerService as any,
      regionService as any,
    ),
    mocks: { redis, apiKeyService, userService, configService, runnerService, regionService },
  }
}

describe('ApiKeyStrategy', () => {
  it.each(['runner', 'region-proxy'])('still checks %s credentials if the owner lookup fails', async (role) => {
    const { strategy, mocks } = createStrategy()
    mocks.configService.get.mockImplementation((name) => (name === 'legal' ? {} : undefined))
    mocks.apiKeyService.findWithCurrentOwner.mockRejectedValue(new Error('owner query failed'))
    if (role === 'runner') mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner' })
    else mocks.regionService.findOneByProxyApiKey.mockResolvedValue({ id: 'region' })

    await expect(strategy.validate('service-key')).resolves.toMatchObject({ role })
    expect(mocks.redis.get).not.toHaveBeenCalled()
    expect(mocks.apiKeyService.updateLastUsedAt).not.toHaveBeenCalled()
  })

  it('denies an adopted key owned by a pending user before reading caches or trying service keys', async () => {
    const { strategy, mocks } = createStrategy()
    mocks.configService.get.mockImplementation((name) => (name === 'legal' ? {} : undefined))
    mocks.apiKeyService.findWithCurrentOwner.mockResolvedValue({
      apiKey: { organizationId: 'org-1', userId: 'pending-user', name: 'key' },
      owner: { id: 'pending-user', registrationConsentPending: true },
    })
    mocks.redis.get.mockResolvedValue(JSON.stringify({ userId: 'old-owner' }))

    await expect(strategy.validate('adopted-key')).rejects.toMatchObject({ status: 401 })
    expect(mocks.redis.get).not.toHaveBeenCalled()
    expect(mocks.apiKeyService.updateLastUsedAt).not.toHaveBeenCalled()
    expect(mocks.runnerService.findByApiKey).not.toHaveBeenCalled()
    expect(mocks.regionService.findOneByProxyApiKey).not.toHaveBeenCalled()
  })
  it('translates historical cached grants without separating the revocation cache', async () => {
    const { strategy, mocks } = createStrategy()
    const key = `api-key:validation:${generateApiKeyHash('cached-key')}`
    const cache = new Map([
      [
        key,
        JSON.stringify({
          userId: 'owner',
          organizationId: 'org-1',
          name: 'key',
          permissions: ['read:tenant', 'write:tenant', 'write:boxes'],
        }),
      ],
    ])
    mocks.redis.get.mockImplementation(async (name: string) => cache.get(name) ?? null)
    mocks.userService.findOne.mockResolvedValue({ id: 'owner', email: 'owner@example.com', role: 'user' })
    const principal = await strategy.validate('cached-key')
    expect(principal).toMatchObject({ apiKey: { permissions: ['read:members', 'write:members', 'write:boxes'] } })
    expect(mocks.apiKeyService.getApiKeyByValue).not.toHaveBeenCalled()

    // The unchanged invalidation key is also used by old API and identity-link instances.
    cache.delete(key)
    await expect(strategy.validate('cached-key')).resolves.toBeNull()
    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledWith('cached-key')
  })

  it('delegates JWT-shaped bearer tokens to the JWT strategy before reading API-key config', async () => {
    const { strategy, mocks } = createStrategy()

    await expect(strategy.validate(jwtToken)).resolves.toBeNull()

    expect(mocks.configService.getOrThrow).not.toHaveBeenCalled()
    expect(mocks.apiKeyService.getApiKeyByValue).not.toHaveBeenCalled()
  })

  it('treats missing internal API-key config as optional for ordinary API-key lookup', async () => {
    const { strategy, mocks } = createStrategy()

    await expect(strategy.validate('unknown-api-key')).resolves.toBeNull()

    expect(mocks.configService.get).toHaveBeenCalledWith('proxy.apiKey')
    expect(mocks.configService.getOrThrow).not.toHaveBeenCalled()
    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledWith('unknown-api-key')
  })

  it('authenticates a token matching the configured billing API key as the billing role', async () => {
    const { strategy, mocks } = createStrategy()
    mocks.configService.get.mockImplementation((key: string) =>
      key === 'billing.apiKey' ? 'billing-secret' : undefined,
    )

    await expect(strategy.validate('billing-secret')).resolves.toEqual({ role: 'billing' })

    expect(mocks.apiKeyService.getApiKeyByValue).not.toHaveBeenCalled()
  })

  it('falls through to ordinary API-key lookup when the token does not match the billing key', async () => {
    const { strategy, mocks } = createStrategy()
    mocks.configService.get.mockImplementation((key: string) =>
      key === 'billing.apiKey' ? 'billing-secret' : undefined,
    )

    await expect(strategy.validate('not-the-billing-secret')).resolves.toBeNull()

    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledWith('not-the-billing-secret')
  })
})
