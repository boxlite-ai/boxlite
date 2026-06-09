jest.mock('./sandbox/services/box-template.service', () => ({
  BoxTemplateService: class BoxTemplateService {},
}))
jest.mock('./sandbox/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('./sandbox/runner-adapter/runnerAdapter', () => ({
  RunnerAdapterFactory: class RunnerAdapterFactory {},
}))

const { AppService } = require('./app.service') as typeof import('./app.service')

describe('AppService registry bootstrap', () => {
  function createService(values: Record<string, unknown> = {}) {
    const dockerRegistryService = {
      getAvailableTransientRegistry: jest.fn().mockResolvedValue(null),
      getAvailableInternalRegistry: jest.fn().mockResolvedValue(null),
      getAvailableBackupRegistry: jest.fn().mockResolvedValue(null),
      findSourceRegistryByTemplateImageName: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    }
    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key]
        if (value === undefined) {
          throw new Error(`Configuration key "${key}" is undefined`)
        }
        return value
      }),
    }

    return {
      dockerRegistryService,
      service: new AppService(
        dockerRegistryService as never,
        configService as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as {
        initializeTransientRegistry: () => Promise<void>
        initializeInternalRegistry: () => Promise<void>
        initializeBackupRegistry: () => Promise<void>
        initializeSystemSourceRegistry: () => Promise<void>
      },
    }
  }

  it('skips transient registry initialization when config is absent', async () => {
    const { dockerRegistryService, service } = createService({
      'defaultRegion.id': 'us',
    })

    await expect(service.initializeTransientRegistry()).resolves.toBeUndefined()

    expect(dockerRegistryService.create).not.toHaveBeenCalled()
    expect(dockerRegistryService.update).not.toHaveBeenCalled()
  })

  it('creates a non-default system source registry when credentials are configured', async () => {
    const { dockerRegistryService, service } = createService({
      'defaultRegion.id': 'us',
      'systemSourceRegistry.name': 'System GHCR',
      'systemSourceRegistry.url': 'ghcr.io',
      'systemSourceRegistry.username': 'boxlite-ci',
      'systemSourceRegistry.password': 'token-test',
      'systemSourceRegistry.projectId': '',
    })

    await expect(service.initializeSystemSourceRegistry()).resolves.toBeUndefined()

    expect(dockerRegistryService.findSourceRegistryByTemplateImageName).toHaveBeenCalledWith('ghcr.io', 'us', undefined)
    expect(dockerRegistryService.create).toHaveBeenCalledWith({
      name: 'System GHCR',
      url: 'ghcr.io',
      username: 'boxlite-ci',
      password: 'token-test',
      project: '',
      registryType: 'internal',
      isDefault: false,
    })
    expect(dockerRegistryService.update).not.toHaveBeenCalled()
  })
})

describe('AppService admin bootstrap', () => {
  it('syncs existing admin organization quota from config', async () => {
    const dockerRegistryService = {
      getAvailableTransientRegistry: jest.fn().mockResolvedValue(null),
      getAvailableInternalRegistry: jest.fn().mockResolvedValue(null),
      getAvailableBackupRegistry: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    }
    const configValues: Record<string, unknown> = {
      'admin.totalCpuQuota': 10,
      'admin.totalMemoryQuota': 40,
      'admin.totalDiskQuota': 100,
      'admin.maxCpuPerSandbox': 4,
      'admin.maxMemoryPerSandbox': 8,
      'admin.maxDiskPerSandbox': 10,
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
      findPersonal: jest.fn().mockResolvedValue({ id: 'org-1' }),
      updateQuota: jest.fn().mockResolvedValue(undefined),
    }
    const apiKeyService = {
      ensureApiKeyValue: jest.fn().mockResolvedValue({ value: 'boxlite-local-admin-key' }),
    }

    const service = new AppService(
      dockerRegistryService as never,
      configService as never,
      userService as never,
      organizationService as never,
      apiKeyService as never,
      {} as never,
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
      maxCpuPerSandbox: 4,
      maxMemoryPerSandbox: 8,
      maxDiskPerSandbox: 10,
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
