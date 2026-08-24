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
