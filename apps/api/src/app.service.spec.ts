import { Logger } from '@nestjs/common'

jest.mock('./box/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('./box/runner-adapter/runnerAdapter', () => ({
  RunnerAdapterFactory: class RunnerAdapterFactory {},
}))

const { AppService } = require('./app.service') as typeof import('./app.service')

describe('AppService admin bootstrap', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('preserves the existing admin organization API key', async () => {
    const configValues: Record<string, unknown> = {
      'admin.apiKey': 'boxlite-local-admin-key',
      'defaultRegion.id': 'us',
    }
    const configService = {
      get: jest.fn((key: string) => configValues[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = configValues[key]
        if (value === undefined) {
          throw new Error(`Configuration key "${key}" is undefined`)
        }
        return value
      }),
    }
    const userService = {
      findOne: jest.fn().mockResolvedValue({ id: 'boxlite-admin' }),
      create: jest.fn(),
    }
    const organizationService = {
      findDefaultForUser: jest.fn().mockResolvedValue({ id: 'org-1' }),
    }
    const apiKeyService = {
      ensureApiKeyValue: jest.fn().mockResolvedValue({ value: 'boxlite-local-admin-key' }),
    }

    const service = new AppService(
      configService as never,
      userService as never,
      organizationService as never,
      apiKeyService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as {
      initializeAdminUser: () => Promise<void>
    }

    await service.initializeAdminUser()

    expect(userService.create).not.toHaveBeenCalled()
    expect(apiKeyService.ensureApiKeyValue).toHaveBeenCalledWith(
      'org-1',
      'boxlite-admin',
      'boxlite-admin',
      [],
      'boxlite-local-admin-key',
    )
  })

  it('BoxLite admin read does not log any fragment of the bootstrapped admin credential', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation()
    const secret = 'backoffice-visible-prefix-and-visible-suffix'
    const configValues: Record<string, unknown> = {
      'admin.apiKey': secret,
      'defaultRegion.id': 'us',
    }
    const configService = {
      get: jest.fn((key: string) => configValues[key]),
      getOrThrow: jest.fn((key: string) => configValues[key]),
    }
    const service = new AppService(
      configService as never,
      { findOne: jest.fn().mockResolvedValue({ id: 'boxlite-admin' }) } as never,
      { findDefaultForUser: jest.fn().mockResolvedValue({ id: 'org-1' }) } as never,
      { ensureApiKeyValue: jest.fn().mockResolvedValue({ value: secret }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { initializeAdminUser: () => Promise<void> }

    await service.initializeAdminUser()

    const logs = JSON.stringify(log.mock.calls)
    expect(logs).not.toContain(secret.slice(0, 4))
    expect(logs).not.toContain(secret.slice(-4))
  })

  it('BoxLite admin read bootstraps an independently configured Backoffice service identity', async () => {
    const configValues: Record<string, unknown> = {
      'backoffice.apiKey': 'independent-backoffice-key',
      'defaultRegion.id': 'us',
    }
    const userService = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'backoffice-service' }),
    }
    const organizationService = {
      findDefaultForUser: jest.fn().mockResolvedValue({ id: 'backoffice-org' }),
    }
    const apiKeyService = {
      ensureApiKeyValue: jest.fn().mockResolvedValue({ value: 'independent-backoffice-key' }),
    }
    const service = new AppService(
      {
        get: jest.fn((key: string) => configValues[key]),
        getOrThrow: jest.fn((key: string) => configValues[key]),
      } as never,
      userService as never,
      organizationService as never,
      apiKeyService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { initializeBackofficeService: () => Promise<void> }

    await service.initializeBackofficeService()

    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'backoffice-service', role: 'admin' }),
    )
    expect(apiKeyService.ensureApiKeyValue).toHaveBeenCalledWith(
      'backoffice-org',
      'backoffice-service',
      'backoffice-service',
      [],
      'independent-backoffice-key',
    )
  })
})
