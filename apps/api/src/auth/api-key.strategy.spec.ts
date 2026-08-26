/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'

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
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('BoxLite admin read never logs API-key characters or credential metadata', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation()
    const { strategy, mocks } = createStrategy()
    const token = 'backoffice-secret-api-key-value'
    mocks.apiKeyService.getApiKeyByValue.mockResolvedValue({
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: 'backoffice-service',
      name: 'backoffice-service',
      keyHash: 'credential-hash-must-not-be-logged',
      keyPrefix: 'backoffice-prefix',
      keySuffix: 'office-suffix',
      permissions: [],
      createdAt: new Date(),
    })
    mocks.userService.findOne.mockResolvedValue({
      id: 'backoffice-service',
      role: 'admin',
      email: 'backoffice-service@boxlite.invalid',
    })

    await expect(strategy.validate(token)).resolves.toEqual(
      expect.objectContaining({ userId: 'backoffice-service', role: 'admin' }),
    )

    const logs = JSON.stringify(debug.mock.calls)
    expect(logs).not.toContain(token.substring(0, 8))
    expect(logs).not.toContain('backoffice-prefix')
    expect(logs).not.toContain('office-suffix')
    expect(logs).not.toContain('credential-hash-must-not-be-logged')
  })

  it('BoxLite admin read does not log a rejected credential or its lookup error', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation()
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    const { strategy, mocks } = createStrategy()
    const token = 'rejected-backoffice-secret'
    mocks.apiKeyService.getApiKeyByValue.mockRejectedValue(new Error(`lookup failed for ${token}`))

    await expect(strategy.validate(token)).resolves.toBeNull()

    const logs = JSON.stringify([...debug.mock.calls, ...error.mock.calls])
    expect(logs).not.toContain(token)
    expect(logs).not.toContain('lookup failed')
  })

  it('BoxLite admin read does not log an expired credential or its metadata', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation()
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    const { strategy, mocks } = createStrategy()
    const token = 'expired-backoffice-secret'
    mocks.apiKeyService.getApiKeyByValue.mockResolvedValue({
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: 'backoffice-service',
      name: 'backoffice-service',
      keyHash: 'expired-credential-hash',
      keyPrefix: 'expired-prefix',
      keySuffix: 'expired-suffix',
      permissions: [],
      createdAt: new Date(),
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })

    await expect(strategy.validate(token)).resolves.toBeNull()

    const logs = JSON.stringify([...debug.mock.calls, ...error.mock.calls])
    for (const secret of [token, 'expired-credential-hash', 'expired-prefix', 'expired-suffix']) {
      expect(logs).not.toContain(secret)
    }
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
