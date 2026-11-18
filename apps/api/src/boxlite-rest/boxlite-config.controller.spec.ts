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
    expect(controller.getConfig().capabilities.import_enabled).toBe(false)
  })
})
