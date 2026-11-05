/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { recordBusinessEvent, recordOutcomes } from './business-event.util'
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
    })
  })

  it('omits optional attributes the event does not carry', () => {
    recordBusinessEvent({ name: 'user.registration', outcome: 'requested', correlationId: 'user-1' })

    const [, attributes] = logSpy.mock.calls[0]
    expect(attributes).not.toHaveProperty('actor.kind')
    expect(attributes).not.toHaveProperty('event.reason')
    expect(attributes).not.toHaveProperty('exception.type')
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

  it('records requested before the operation and success after it, and returns its result', async () => {
    const op = jest.fn(async () => {
      expect(logSpy.mock.calls.map(([message]) => message)).toEqual(['user.registration requested'])
      return 'created'
    })

    await expect(recordOutcomes(event, op, () => 'internal')).resolves.toBe('created')

    expect(op).toHaveBeenCalledTimes(1)
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
})
