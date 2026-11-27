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

  it('caches runner authentication before the user API-key lookup', async () => {
    const { strategy, mocks } = createStrategy()
    mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner-1', apiKey: 'runner-token' })

    const first = await strategy.validate('runner-token')
    const second = await strategy.validate('runner-token')

    expect(first).toMatchObject({ role: 'runner', runnerId: 'runner-1' })
    expect(second).toEqual(first)
    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledTimes(1)
    expect(mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(1)
    expect(mocks.regionService.findOneByProxyApiKey).not.toHaveBeenCalled()
  })

  it('refreshes runner authentication after the 60-second TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const { strategy, mocks } = createStrategy()
    mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner-1', apiKey: 'runner-token' })
    try {
      await strategy.validate('runner-token')
      now.mockReturnValue(61_000)
      await strategy.validate('runner-token')

      expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledTimes(2)
      expect(mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('does not cache an invalid runner token', async () => {
    const { strategy, mocks } = createStrategy()

    await expect(strategy.validate('invalid-runner')).resolves.toBeNull()
    await expect(strategy.validate('invalid-runner')).resolves.toBeNull()

    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledTimes(2)
    expect(mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(2)
    expect(mocks.regionService.findOneByProxyApiKey).toHaveBeenCalledTimes(2)
  })

  it('does not share runner authentication between strategy instances', async () => {
    const first = createStrategy()
    const second = createStrategy()
    first.mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner-1', apiKey: 'runner-token' })
    second.mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner-1', apiKey: 'runner-token' })

    await first.strategy.validate('runner-token')
    await second.strategy.validate('runner-token')

    expect(first.mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(1)
    expect(second.mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(1)
  })

  it('bypasses the runner authentication cache when its independent switch is off', async () => {
    const { strategy, mocks } = createStrategy()
    mocks.configService.get.mockImplementation((key: string) => (key === 'runnerAuthCache.enabled' ? false : undefined))
    mocks.runnerService.findByApiKey.mockResolvedValue({ id: 'runner-1', apiKey: 'runner-token' })

    await strategy.validate('runner-token')
    await strategy.validate('runner-token')

    expect(mocks.apiKeyService.getApiKeyByValue).toHaveBeenCalledTimes(2)
    expect(mocks.runnerService.findByApiKey).toHaveBeenCalledTimes(2)
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
