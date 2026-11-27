/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, GatewayTimeoutException, Logger, RequestTimeoutException } from '@nestjs/common'
import { Context } from '../../common/context/context'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'
import { BoxReadinessError } from '../errors/box-readiness.error'
import { beginBoxOperation } from './box-operation.util'

describe('Cloud Box operation accounting', () => {
  let observed: Readonly<Record<string, string>>[]
  let dispose: () => void
  const options = { kind: 'create', organizationId: 'org-1', ctx: Context.user(), scope: 'rest_api' } as const

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-29T08:00:00Z'))
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    observed = []
    dispose = subscribeBusinessEvents((event) => observed.push(event))
  })
  afterEach(() => {
    dispose()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('correlates distinct occurrences and measures monotonic time across a wall-clock correction', () => {
    const finish = beginBoxOperation(options)
    jest.advanceTimersByTime(25)
    jest.setSystemTime(new Date('2000-01-01T00:00:00Z'))
    finish({ outcome: 'success', boxId: 'box-1' })
    finish({ outcome: 'exception', error: new Error('late error') })

    expect(observed).toHaveLength(2)
    expect(observed[0]['event.id']).not.toBe(observed[1]['event.id'])
    expect(observed[0]['operation.id']).toBe(observed[1]['operation.id'])
    expect(observed[0]['operation.requested_at']).toBe(observed[1]['operation.requested_at'])
    expect(observed[1]).toMatchObject({
      'operation.result': 'success',
      'operation.duration_ms': '25',
      'operation.boundary': 'cloud_api_to_started',
      'traffic.kind': 'unknown',
      'box.id': 'box-1',
    })
  })

  it.each([
    [new RequestTimeoutException('private-timeout'), 'timeout'],
    [new GatewayTimeoutException('private-timeout'), 'timeout'],
    [new BadRequestException('private-validation'), 'user_error'],
    [new BoxReadinessError('private-runner-error'), 'service_error'],
    [new Error('private-database-error'), 'service_error'],
    [undefined, 'service_error'],
  ])('classifies a failure without exporting its message: %s', (error, result) => {
    beginBoxOperation(options)({ outcome: 'exception', error })
    expect(observed[1]).toMatchObject({ 'operation.result': result, 'exception.type': result })
    expect(JSON.stringify(observed)).not.toContain('private-')
  })

  it('keeps zero elapsed time and separates cancelled observations from service failures', () => {
    beginBoxOperation(options)({ outcome: 'cancelled' })
    expect(observed[1]).toMatchObject({ 'operation.result': 'cancelled', 'operation.duration_ms': '0' })
  })

  it('gives concurrent callers independent attempts', () => {
    const first = beginBoxOperation(options)
    const second = beginBoxOperation(options)
    second({ outcome: 'success' })
    first({ outcome: 'success' })
    expect(observed[0]['operation.id']).not.toBe(observed[1]['operation.id'])
    expect(observed[2]['operation.id']).toBe(observed[1]['operation.id'])
    expect(observed[3]['operation.id']).toBe(observed[0]['operation.id'])
  })
})
