import { ConfigService } from '@nestjs/config'
import { BoxliteConfigController } from './boxlite-config.controller'
import express from 'express'
import { RequestReplayPolicy } from './request-replay-policy'

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

describe('request replay capability discovery', () => {
  it('advertises the actual retention without inventing operations before route registration', () => {
    expect(new BoxliteConfigController().getConfig().capabilities).toMatchObject({
      idempotency_key_lifetime: 'PT24H',
      idempotency_operations: [],
    })
  })

  it('returns the registered operation list independently of caller mutation', () => {
    const app = express()
    app.post('/api/v1/boxes', (_req, res) => res.end())
    const policy = new RequestReplayPolicy()
    policy.configure(app, { paths: { '/{prefix}/boxes': { post: { operationId: 'createBox' } } } })
    const controller = new BoxliteConfigController(undefined, policy)
    const capabilities = controller.getConfig().capabilities
    expect(capabilities.idempotency_operations).toEqual(['createBox'])
    capabilities.idempotency_operations.length = 0
    expect(controller.getConfig().capabilities.idempotency_operations).toEqual(['createBox'])
  })
})
