import { ConfigService } from '@nestjs/config'
import { BoxliteConfigController } from './boxlite-config.controller'

describe('checkpoint capability discovery', () => {
  it.each([undefined, 'gs://checkpoint-test/archives/'])(
    'reflects configured checkpoint storage: %s',
    (archivePrefix) => {
      const controller = new BoxliteConfigController(new ConfigService({ checkpoint: { archivePrefix } }))
      expect(controller.getConfig().capabilities.checkpoints_enabled).toBe(!!archivePrefix)
      expect(controller.getConfig().capabilities.import_enabled).toBe(false)
    },
  )
})
