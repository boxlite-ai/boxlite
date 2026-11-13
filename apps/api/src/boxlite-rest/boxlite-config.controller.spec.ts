import { TypedConfigService } from '../config/typed-config.service'
import { BoxliteConfigController } from './boxlite-config.controller'

function createConfig(values: {
  checkpoint?: { archivePrefix?: string; enabled?: boolean }
  objectStorageConfigured?: boolean
  filestoreInstanceCount?: number
}) {
  return {
    get: (key: string) => {
      if (key === 'checkpoint.enabled') return values.checkpoint?.enabled
      if (key === 'checkpoint.archivePrefix') return values.checkpoint?.archivePrefix
      if (key === 's3.endpoint') return values.objectStorageConfigured ? 'http://object-storage.test' : undefined
      return undefined
    },
    getOrThrow: (key: string) => {
      if (key === 'volume.filestoreInstances')
        return {
          instances: Array(values.filestoreInstanceCount ?? 0)
            .fill('ml')
            .map((instance) => ({ instance, projectId: 'boxlite-dev', zone: 'us-east5-a' })),
        }
      throw new Error(`Unexpected configuration key: ${key}`)
    },
  } as TypedConfigService
}

describe('checkpoint capability discovery', () => {
  it.each([
    { archivePrefix: undefined, enabled: true, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: undefined, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: false, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: true, expected: true },
  ])('advertises checkpoint admission only after rollout: %j', ({ archivePrefix, enabled, expected }) => {
    const controller = new BoxliteConfigController(
      createConfig({ checkpoint: { archivePrefix, enabled }, objectStorageConfigured: true }),
    )
    expect(controller.getConfig().capabilities.checkpoints_enabled).toBe(expected)
    expect(controller.getConfig().capabilities.import_enabled).toBe(false)
  })
})

describe('volume storage capability discovery', () => {
  it.each([
    { objectStorageConfigured: false, filestoreInstanceCount: 0, objectExpected: false, filestoreExpected: false },
    { objectStorageConfigured: true, filestoreInstanceCount: 0, objectExpected: true, filestoreExpected: false },
    { objectStorageConfigured: false, filestoreInstanceCount: 2, objectExpected: false, filestoreExpected: true },
  ])(
    'advertises configured volume backends: %j',
    ({ objectStorageConfigured, filestoreInstanceCount, objectExpected, filestoreExpected }) => {
      const controller = new BoxliteConfigController(createConfig({ objectStorageConfigured, filestoreInstanceCount }))

      expect(controller.getConfig().capabilities.object_storage_enabled).toBe(objectExpected)
      expect(controller.getConfig().capabilities.filestore_enabled).toBe(filestoreExpected)
    },
  )
})
