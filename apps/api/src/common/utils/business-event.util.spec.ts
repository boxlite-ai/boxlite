/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { recordBusinessEvent, recordOutcomes, subscribeBusinessEvents } from './business-event.util'
import { Context } from '../context/context'
import { PlatformReason } from '../context/platform-reason.enum'

describe('recordBusinessEvent', () => {
  const now = new Date('2026-09-30T08:00:00.000Z')
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now)
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('logs a requested event at info level with its attributes', () => {
    recordBusinessEvent({
      name: 'box.delete',
      outcome: 'requested',
      correlationId: 'box-1',
      ctx: Context.platform(PlatformReason.AUTO_DELETE),
    })

    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('box.delete requested', {
      'event.name': 'box.delete',
      'event.outcome': 'requested',
      'correlation.id': 'box-1',
      'actor.kind': 'platform',
      'event.reason': 'auto_delete',
      'service.type': 'api',
      'event.timestamp': '2026-09-30T08:00:00.000Z',
      'event.id': expect.any(String),
    })
  })

  it('shares one occurrence ID with observers and keeps separate occurrences distinct', () => {
    const observed: Readonly<Record<string, string>>[] = []
    const dispose = subscribeBusinessEvents((attributes) => observed.push(attributes))
    try {
      recordBusinessEvent({ name: 'box.start', outcome: 'requested', correlationId: 'box-1' })
      recordBusinessEvent({ name: 'box.start', outcome: 'success', correlationId: 'box-1' })
      expect(observed[0]['event.id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(observed[1]['event.id']).not.toBe(observed[0]['event.id'])
      expect(logSpy.mock.calls.map(([, attributes]) => attributes)).toEqual(observed)
    } finally {
      dispose()
    }
  })

  it('preserves source occurrence identity and time', () => {
    const event = {
      name: 'box.start' as const,
      outcome: 'success' as const,
      correlationId: 'box-1',
      eventId: '11111111-1111-4111-8111-111111111111',
      occurredAt: new Date('2026-09-29T08:00:00.000Z'),
    }
    recordBusinessEvent(event)
    expect(logSpy.mock.calls[0][1]).toMatchObject({
      'event.id': event.eventId,
      'event.timestamp': event.occurredAt.toISOString(),
    })
  })

  it('falls back to observation time for an invalid source clock', () => {
    const event = {
      name: 'box.start' as const,
      outcome: 'success' as const,
      correlationId: 'box-1',
      occurredAt: new Date(NaN),
    }
    expect(() => recordBusinessEvent(event)).not.toThrow()
    expect(logSpy.mock.calls[0][1]['event.timestamp']).toBe(now.toISOString())
  })

  it("isolates an observer that attempts to alter another observer's attributes", () => {
    const mutate = subscribeBusinessEvents((attributes) => {
      const writable = attributes as Record<string, string>
      writable['event.name'] = 'user.login'
    })
    const observed = jest.fn()
    const dispose = subscribeBusinessEvents(observed)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      recordBusinessEvent({ name: 'box.start', outcome: 'success', correlationId: 'box-1' })
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ 'event.name': 'box.start' }))
      expect(Logger.prototype.warn).toHaveBeenCalledWith('Business event analytics capture failed')
    } finally {
      mutate()
      dispose()
    }
  })

  it('omits optional attributes the event does not carry', () => {
    recordBusinessEvent({ name: 'user.registration', outcome: 'requested', correlationId: 'user-1' })

    const [, attributes] = logSpy.mock.calls[0]
    for (const key of ['actor.kind', 'event.reason', 'exception.type', 'organization.id', 'user.id', 'auth.method']) {
      expect(attributes).not.toHaveProperty(key)
    }
  })

  it('records the organization and the person behind a request, and how they called', () => {
    recordBusinessEvent({
      name: 'box.exec',
      outcome: 'requested',
      correlationId: 'box-1',
      organizationId: 'org-1',
      ctx: Context.user({ userId: 'user-1', authMethod: 'api_key', clientSource: 'sdk-python', sdkVersion: '0.9.0' }),
    })

    const [, attributes] = logSpy.mock.calls[0]
    expect(attributes).toEqual(
      expect.objectContaining({
        'organization.id': 'org-1',
        'actor.kind': 'user',
        'user.id': 'user-1',
        'auth.method': 'api_key',
        'client.source': 'sdk-python',
        'sdk.version': '0.9.0',
      }),
    )
  })

  it('leaves out client labels the caller did not send', () => {
    recordBusinessEvent({
      name: 'org.active',
      outcome: 'success',
      correlationId: 'user-1',
      organizationId: 'org-1',
      ctx: Context.user({ userId: 'user-1', authMethod: 'jwt' }),
    })

    const [, attributes] = logSpy.mock.calls[0]
    expect(attributes['auth.method']).toBe('jwt')
    expect(attributes).not.toHaveProperty('client.source')
    expect(attributes).not.toHaveProperty('sdk.version')
  })

  it('records a user or admin actor without a reason', () => {
    recordBusinessEvent({ name: 'box.stop', outcome: 'requested', correlationId: 'box-1', ctx: Context.user() })

    const [, attributes] = logSpy.mock.calls[0]
    expect(attributes['actor.kind']).toBe('user')
    expect(attributes).not.toHaveProperty('event.reason')
  })

  it('logs an exception event at error level with its category and no error text', () => {
    recordBusinessEvent({
      name: 'box.stop',
      outcome: 'exception',
      correlationId: 'box-2',
      exceptionType: 'runner_job_failed',
    })

    expect(logSpy).not.toHaveBeenCalled()
    const [message, attributes] = errorSpy.mock.calls[0]
    expect(message).toBe('box.stop exception')
    expect(attributes['exception.type']).toBe('runner_job_failed')
    expect(attributes).not.toHaveProperty('exception.message')
  })
})

describe('recordOutcomes', () => {
  const event = { name: 'user.registration', correlationId: 'user-1', ctx: Context.admin() } as const
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('keeps occurrence overrides out of a shared lifecycle input', async () => {
    const source = {
      ...event,
      eventId: '11111111-1111-4111-8111-111111111111',
      occurredAt: new Date('2000-01-01T00:00:00Z'),
    }
    await recordOutcomes(
      source,
      async () => 42,
      () => 'internal',
    )
    const attributes = logSpy.mock.calls.map(([, attributes]) => attributes)
    expect(attributes).toHaveLength(2)
    expect(new Set(attributes.map((attributes) => attributes['event.id'])).size).toBe(2)
    for (const observed of attributes) {
      expect(observed['event.id']).not.toBe(source.eventId)
      expect(observed['event.timestamp']).not.toBe(source.occurredAt.toISOString())
    }
  })

  it('records requested before the operation and success after it, and returns its result', async () => {
    const op = jest.fn(async () => {
      expect(logSpy.mock.calls.map(([message]) => message)).toEqual(['user.registration requested'])
      return 'created'
    })

    await expect(recordOutcomes(event, op, () => 'internal')).resolves.toBe('created')

    expect(op).toHaveBeenCalledTimes(1)
    const ids = logSpy.mock.calls.map(([, attributes]) => attributes['event.id'])
    expect(ids).toEqual([expect.any(String), expect.any(String)])
    expect(new Set(ids).size).toBe(2)
    expect(logSpy.mock.calls.map(([message]) => message)).toEqual([
      'user.registration requested',
      'user.registration success',
    ])
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('records the classified exception instead of success, and rethrows', async () => {
    const failure = new Error('duplicate key')

    await expect(
      recordOutcomes(
        event,
        () => Promise.reject(failure),
        () => 'user_conflict',
      ),
    ).rejects.toBe(failure)

    expect(logSpy.mock.calls.map(([message]) => message)).toEqual(['user.registration requested'])
    const [message, attributes] = errorSpy.mock.calls[0]
    expect(message).toBe('user.registration exception')
    expect(attributes).toEqual(expect.objectContaining({ 'actor.kind': 'admin', 'exception.type': 'user_conflict' }))
  })

  // A registration's organization exists only once the operation has created it.
  it('records the organization the operation created on its success only', async () => {
    await recordOutcomes(
      event,
      async () => ({ organizationId: 'org-1' }),
      () => 'internal',
      (result) => result.organizationId,
    )

    const [[, requested], [, success]] = logSpy.mock.calls
    expect(requested).not.toHaveProperty('organization.id')
    expect(success['organization.id']).toBe('org-1')
  })

  it('keeps the event organization when the operation names none', async () => {
    await recordOutcomes(
      { ...event, organizationId: 'org-1' },
      async () => undefined,
      () => 'internal',
      () => undefined,
    )

    expect(logSpy.mock.calls.map(([, attributes]) => attributes['organization.id'])).toEqual(['org-1', 'org-1'])
  })
})
