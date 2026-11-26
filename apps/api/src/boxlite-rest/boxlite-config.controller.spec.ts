import { ConfigService } from '@nestjs/config'
import { BoxliteConfigController } from './boxlite-config.controller'

describe('checkpoint capability discovery', () => {
  it.each([
    { archivePrefix: undefined, enabled: true, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: undefined, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: false, expected: false },
    { archivePrefix: 'gs://checkpoint-test/archives/', enabled: true, expected: true },
  ])('advertises checkpoint admission only after rollout: %j', ({ archivePrefix, enabled, expected }) => {
    const controller = new BoxliteConfigController(new ConfigService({ checkpoint: { archivePrefix, enabled } }))
    expect(controller.getConfig().capabilities.checkpoints_enabled).toBe(expected)
    expect(controller.getConfig().capabilities.memory_checkpoints_enabled).toBe(false)
    expect(controller.getConfig().capabilities.import_enabled).toBe(false)
  })

  it.each([
    { enabled: true, memoryEnabled: true, archivePrefix: undefined, expected: false },
    { enabled: false, memoryEnabled: true, archivePrefix: 'gs://checkpoint-test/archives/', expected: false },
    { enabled: true, memoryEnabled: true, archivePrefix: 'gs://checkpoint-test/archives/', expected: true },
  ])('advertises memory checkpoints only when fully enabled: %j', ({ expected, ...checkpoint }) => {
    const controller = new BoxliteConfigController(new ConfigService({ checkpoint }))
    expect(controller.getConfig().capabilities.memory_checkpoints_enabled).toBe(expected)
  })
})
