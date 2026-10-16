import { Context } from './common/context/context'
import { PlatformReason } from './common/context/platform-reason.enum'

jest.mock('./box/services/runner.service', () => ({
  RunnerService: class RunnerService {},
}))
jest.mock('./box/runner-adapter/runnerAdapter', () => ({
  RunnerAdapterFactory: class RunnerAdapterFactory {},
}))

const { AppService } = require('./app.service') as typeof import('./app.service')

function makeAppService(existingAdmin: { id: string } | null) {
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
    findOne: jest.fn().mockResolvedValue(existingAdmin),
    create: jest.fn().mockResolvedValue({ id: 'boxlite-admin' }),
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
  return { service, userService, apiKeyService }
}

describe('AppService admin bootstrap', () => {
  it('preserves the existing admin organization API key', async () => {
    const { service, userService, apiKeyService } = makeAppService({ id: 'boxlite-admin' })

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

  it('creates a missing admin as a platform bootstrap registration', async () => {
    const { service, userService } = makeAppService(null)

    await service.initializeAdminUser()

    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'boxlite-admin' }),
      Context.platform(PlatformReason.BOOTSTRAP),
    )
  })
})
