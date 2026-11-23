/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
const mockCapture = jest.fn()
const mockOn = jest.fn()
const mockShutdown = jest.fn().mockResolvedValue(undefined)
jest.mock('./consent-bound-posthog', () => ({
  ConsentBoundPostHog: jest.fn(() => ({
    deliver: mockCapture,
    shutdown: mockShutdown,
    on: mockOn,
  })),
}))

import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { ConsentBoundPostHog } from './consent-bound-posthog'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'
import { recordBusinessEvent, recordOutcomes, subscribeBusinessEvents } from '../../common/utils/business-event.util'
import { TypedConfigService } from '../../config/typed-config.service'
import { AnalyticsConsentService } from './analytics-consent.service'
import { grantedAnalyticsConsent } from '../../../test/granted-analytics-consent'
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
      providers: [
        AnalyticsService,
        { provide: AnalyticsConsentService, useValue: grantedAnalyticsConsent },
        { provide: TypedConfigService, useValue: { get: (key: string) => config[key] } },
      ],
    }).compile()
    await module.init()
  })
  afterEach(async () => {
    await module.close()
    jest.restoreAllMocks()
  })

  it('captures requested and terminal events through the existing PostHog client', async () => {
    const ctx = Context.user({ userId: 'user-1', authMethod: 'api_key', clientSource: 'sdk', sdkVersion: '0.9.7' })
    await expect(
      recordOutcomes(
        { name: 'box.create', correlationId: 'box-1', organizationId: 'org-1', ctx },
        async () => 42,
        () => 'internal',
      ),
    ).resolves.toBe(42)
    expect(mockCapture.mock.calls.map(([event]) => event.properties['event.outcome'])).toEqual(['requested', 'success'])
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'box.create',
        distinctId: 'user-1',
        groups: { organization: 'org-1' },
        timestamp: expect.any(Date),
        properties: expect.objectContaining({
          activity_schema: '1',
          environment: 'test',
          'correlation.id': 'box-1',
          'organization.id': 'org-1',
          'user.id': 'user-1',
          'auth.method': 'api_key',
          'client.source': 'sdk',
          'sdk.version': '0.9.7',
        }),
      }),
    )
    expect(ConsentBoundPostHog).toHaveBeenCalledTimes(1)
  })
  it('captures classified failures without leaking the business exception', async () => {
    const failure = new Error('secret database failure')
    await expect(
      recordOutcomes(
        {
          name: 'box.stop',
          correlationId: 'box-1',
          organizationId: 'org-1',
          ctx: Context.platform(PlatformReason.AUTO_STOP),
        },
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
    expect(ConsentBoundPostHog).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('secret database failure')
  })
  it('does not invent a person for preview presence', () => {
    recordBusinessEvent({ name: 'box.open', outcome: 'success', correlationId: 'box-1', organizationId: 'org-1' })
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'anonymous:box-1',
        properties: expect.objectContaining({ $process_person_profile: false }),
      }),
    )
    expect(mockCapture.mock.calls[0][0].properties).not.toHaveProperty('user.id')
  })

  it('keeps Cloud operation metrics out of Activity totals', () => {
    recordBusinessEvent({
      name: 'cloud.box.create',
      outcome: 'requested',
      correlationId: 'operation-1',
      organizationId: 'org-1',
    })
    const capture = mockCapture.mock.calls[0][0]
    expect(capture.properties.cloud_metrics_schema).toBe('1')
    expect(capture.properties).not.toHaveProperty('activity_schema')
    expect(capture.groups).toEqual({ organization: 'org-1' })
  })

  it('uses the same occurrence UUID and timestamp as the operational log', () => {
    recordBusinessEvent({ name: 'box.start', outcome: 'success', correlationId: 'box-1', organizationId: 'org-1' })
    const attributes = jest
      .mocked(Logger.prototype.log)
      .mock.calls.find(([message]) => message === 'box.start success')?.[1] as Record<string, string>
    const capture = mockCapture.mock.calls[0][0]
    expect(capture.uuid).toEqual(expect.any(String))
    expect(capture.uuid).toBe(attributes['event.id'])
    expect(capture.timestamp.toISOString()).toBe(attributes['event.timestamp'])
  })

  it('preserves business results when capture throws', async () => {
    mockCapture.mockImplementation(() => {
      throw new Error('transport secret')
    })
    await expect(
      recordOutcomes(
        { name: 'box.stop', correlationId: 'box-1', organizationId: 'org-1' },
        async () => 42,
        () => 'internal',
      ),
    ).resolves.toBe(42)
    expect(mockCapture).toHaveBeenCalledTimes(2)
    expect(Logger.prototype.warn).toHaveBeenCalledWith('PostHog analytics capture failed')
    expect(JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls)).not.toContain('transport secret')
  })

  it.each([
    ['user.login', 'user-1', 'user-1', true],
    ['box.stop', 'box-1', 'anonymous:box-1', false],
  ] as const)('keeps %s identity and person-profile semantics', (name, correlationId, distinctId, profile) => {
    recordBusinessEvent({
      name,
      outcome: 'success',
      correlationId,
      organizationId: name === 'box.stop' ? 'org-1' : undefined,
    })
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: name,
        distinctId,
        timestamp: expect.any(Date),
        properties: expect.objectContaining({
          activity_schema: '1',
          environment: 'test',
          $process_person_profile: profile,
        }),
      }),
    )
  })

  it('isolates an observer failure while delivering to remaining subscribers', () => {
    const observed = jest.fn()
    const fail = subscribeBusinessEvents(() => {
      throw new Error('private-observer-error')
    })
    const stop = subscribeBusinessEvents(observed)
    try {
      recordBusinessEvent({ name: 'box.stop', outcome: 'success', correlationId: 'box-1', organizationId: 'org-1' })
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ 'event.name': 'box.stop' }))
      expect(Logger.prototype.warn).toHaveBeenCalledWith('Business event analytics capture failed')
      expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain('private-observer-error')
    } finally {
      fail()
      stop()
    }
  })

  it('keeps group-identification and SDK delivery failures out of business results', async () => {
    mockCapture.mockImplementationOnce(() => {
      throw new Error('private-group-error')
    })
    await expect(
      module.get(AnalyticsService).handleOrganizationCreatedEvent({
        id: 'org-1',
        name: 'Example',
        createdAt: new Date(1),
        createdBy: 'user-1',
        users: [{ userId: 'user-1', isDefaultForUser: true }],
      } as never),
    ).resolves.toBeUndefined()
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$groupidentify',
        properties: expect.objectContaining({ $group_key: 'org-1' }),
      }),
    )
    const deliveryFailure = mockOn.mock.calls.find(([name]) => name === 'error')![1]
    deliveryFailure(new Error('private-delivery-error'))
    expect(Logger.prototype.warn).toHaveBeenCalledWith('PostHog analytics capture failed')
    expect(Logger.prototype.warn).toHaveBeenCalledWith('PostHog analytics delivery failed')
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain('private-')
  })

  it('closes the module even when queued PostHog shutdown rejects', async () => {
    mockShutdown.mockRejectedValueOnce(new Error('private-shutdown-error'))
    await expect(module.close()).resolves.toBeUndefined()
    expect(Logger.prototype.warn).toHaveBeenCalledWith('PostHog analytics shutdown failed')
    expect(JSON.stringify(jest.mocked(Logger.prototype.warn).mock.calls)).not.toContain('private-shutdown-error')
  })

  it('unsubscribes before shutdown and waits for the queued delivery', async () => {
    recordBusinessEvent({ name: 'box.stop', outcome: 'requested', correlationId: 'box-1', organizationId: 'org-1' })
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
    recordBusinessEvent({ name: 'box.stop', outcome: 'success', correlationId: 'box-1', organizationId: 'org-1' })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(closed).toBe(false)
    finish!()
    await closing
    mockShutdown.mockResolvedValue(undefined)
  })
})
