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
      'admin.totalCpuQuota': 10,
      'admin.totalMemoryQuota': 40,
      'admin.totalDiskQuota': 100,
      'admin.maxCpuPerBox': 4,
      'admin.maxMemoryPerBox': 8,
      'admin.maxDiskPerBox': 10,
      'admin.templateQuota': 100,
      'admin.maxTemplateSize': 100,
      'admin.volumeQuota': 100,
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
      updateQuota: jest.fn().mockResolvedValue(undefined),
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
    expect(organizationService.updateQuota).toHaveBeenCalledWith('org-1', {
      maxCpuPerBox: 4,
      maxMemoryPerBox: 8,
      maxDiskPerBox: 10,
      templateQuota: 100,
      maxTemplateSize: 100,
      volumeQuota: 100,
    })
    expect(apiKeyService.ensureApiKeyValue).toHaveBeenCalledWith(
      'org-1',
      'boxlite-admin',
      'boxlite-admin',
      [],
      'boxlite-local-admin-key',
    )
  })
})
