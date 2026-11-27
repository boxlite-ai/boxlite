import { ConfigService } from '@nestjs/config'
import { BoxliteConfigController } from './boxlite-config.controller'

it.each([
  [undefined, true],
  ['false', false],
])('advertises file upload capability with override %s', (value, enabled) => {
  const environment = { ...process.env }
  if (value === undefined) delete environment.BOXLITE_FILE_UPLOAD_WS_ENABLED
  else environment.BOXLITE_FILE_UPLOAD_WS_ENABLED = value
  const env = jest.replaceProperty(process, 'env', environment)
  try {
    expect(new BoxliteConfigController().getConfig().capabilities.file_upload_ws_enabled).toBe(enabled)
  } finally {
    env.restore()
  }
})

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
})
