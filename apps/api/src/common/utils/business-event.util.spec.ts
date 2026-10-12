/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { recordBusinessEvent } from './business-event.util'

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
      orgId: 'org-1',
      actorKind: 'auto_delete',
    })

    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('box.delete requested', {
      'event.name': 'box.delete',
      'event.outcome': 'requested',
      'correlation.id': 'box-1',
      'org.id': 'org-1',
      'actor.kind': 'auto_delete',
      'service.type': 'api',
      'event.timestamp': '2026-09-30T08:00:00.000Z',
    })
  })

  it('omits optional attributes the event does not carry', () => {
    recordBusinessEvent({ name: 'user.registration', outcome: 'requested', correlationId: 'user-1' })

    const [, attributes] = logSpy.mock.calls[0]
    expect(attributes).not.toHaveProperty('org.id')
    expect(attributes).not.toHaveProperty('actor.kind')
    expect(attributes).not.toHaveProperty('exception.type')
  })

  it('logs an exception event at error level with its category and no error text', () => {
    recordBusinessEvent({
      name: 'box.stop',
      outcome: 'exception',
      correlationId: 'box-2',
      orgId: 'org-2',
      exceptionType: 'runner_job_failed',
    })

    expect(logSpy).not.toHaveBeenCalled()
    const [message, attributes] = errorSpy.mock.calls[0]
    expect(message).toBe('box.stop exception')
    expect(attributes['exception.type']).toBe('runner_job_failed')
    expect(attributes).not.toHaveProperty('exception.message')
  })
})
