/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
const mockCapture = jest.fn()
const mockShutdown = jest.fn().mockResolvedValue(undefined)
jest.mock('posthog-node', () => ({
  PostHog: jest.fn(() => ({ capture: mockCapture, shutdown: mockShutdown, on: jest.fn(), groupIdentify: jest.fn() })),
}))

import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { PostHog } from 'posthog-node'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { recordBusinessEvent, recordOutcomes } from '../../common/utils/business-event.util'
import { TypedConfigService } from '../../config/typed-config.service'
import { AnalyticsService } from './analytics.service'

describe('PostHog business events', () => {
  let module: TestingModule
  const config: Record<string, string> = {
    'posthog.apiKey': 'phc_test',
    'posthog.host': 'https://posthog.test',
    'posthog.environment': 'test',
  }
  beforeEach(async () => {
    jest.clearAllMocks()
    mockCapture.mockReset()
    mockShutdown.mockReset().mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    module = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: TypedConfigService, useValue: { get: (key: string) => config[key] } }],
    }).compile()
    await module.init()
  })
  afterEach(async () => {
    await module.close()
    jest.restoreAllMocks()
  })

  it('captures classified failures without leaking the business exception', async () => {
    const failure = new Error('secret database failure')
    await expect(
      recordOutcomes(
        { name: 'box.stop', correlationId: 'box-1', ctx: Context.platform(PlatformReason.AUTO_STOP) },
        async () => {
          throw failure
        },
        () => 'runner_failed',
      ),
    ).rejects.toBe(failure)
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'platform:box-1',
        properties: expect.objectContaining({
          'event.outcome': 'exception',
          'exception.type': 'runner_failed',
          'actor.kind': 'platform',
          $process_person_profile: false,
        }),
      }),
    )
    expect(PostHog).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('secret database failure')
  })
  it('preserves business results when capture throws', async () => {
    mockCapture.mockImplementation(() => {
      throw new Error('transport secret')
    })
    await expect(
      recordOutcomes(
        { name: 'box.stop', correlationId: 'box-1' },
        async () => 42,
        () => 'internal',
      ),
    ).resolves.toBe(42)
    expect(mockCapture).toHaveBeenCalledTimes(2)
    expect(Logger.prototype.warn).toHaveBeenCalledWith('PostHog analytics capture failed')
    expect(JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls)).not.toContain('transport secret')
  })

  it('unsubscribes before shutdown and waits for the queued delivery', async () => {
    recordBusinessEvent({ name: 'box.stop', outcome: 'requested', correlationId: 'box-1' })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    let finish: () => void
    let start: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    mockShutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
          start!()
        }),
    )
    let closed = false
    const closing = module.close().then(() => {
      closed = true
    })
    // Nest shutdown visits module-destroy hooks before application-shutdown hooks.
    await started
    expect(mockShutdown).toHaveBeenCalledWith(5000)
    recordBusinessEvent({ name: 'box.stop', outcome: 'success', correlationId: 'box-1' })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(closed).toBe(false)
    finish!()
    await closing
    mockShutdown.mockResolvedValue(undefined)
  })
})
