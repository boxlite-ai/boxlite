jest.mock('./box/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('./box/runner-adapter/runnerAdapter', () => ({
  RunnerAdapterFactory: class RunnerAdapterFactory {},
}))

const { AppService } = require('./app.service') as typeof import('./app.service')

describe('AppService admin bootstrap', () => {
  it('syncs existing admin organization quota from config', async () => {
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
})
