/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { Logger, RequestTimeoutException } from '@nestjs/common'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'

const organization = { id: 'org-1', suspended: false } as any

function makeHarness(initial: Record<string, unknown>) {
  const boxService = { ensureStartedForProxy: jest.fn().mockResolvedValue(initial) }
  const waiter = {
    waitForStarted: jest.fn().mockResolvedValue({ state: BoxState.STARTED }),
    waitForStopped: jest.fn().mockResolvedValue({ state: BoxState.STOPPED }),
  }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  return {
    admittedBox: initial as never,
    service: new BoxAutoResumeService(boxService as never, waiter as never, redisLockProvider as never),
    boxService,
    waiter,
    redisLockProvider,
  }
}

describe('BoxAutoResumeService', () => {
  let observed: Readonly<Record<string, string>>[]
  let dispose: () => void
  beforeEach(() => {
    observed = []
    dispose = subscribeBusinessEvents((event) => observed.push(event))
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    dispose()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })
  it('returns immediately for an already STARTED box', async () => {
    const { service, admittedBox, waiter, redisLockProvider } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady(admittedBox, organization)
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
    expect(redisLockProvider.lock.mock.calls).toEqual([['box:box-1:state-change', 30]])
    expect(redisLockProvider.unlock.mock.calls).toEqual([['box:box-1:state-change']])
    expect(observed).toEqual([])
  })

  it('joins an in-flight Start and waits for STARTED', async () => {
    const { service, admittedBox, waiter } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady(admittedBox, organization)
    expect(waiter.waitForStarted).toHaveBeenCalledWith('box-1', 'org-1', 30, expect.any(Function))
    expect(observed.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
    expect(observed[1]).toMatchObject({
      'event.name': 'cloud.box.resume',
      'operation.scope': 'proxy_api',
      'actor.kind': 'platform',
      'event.reason': 'auto_resume',
      'box.id': 'box-1',
    })
  })

  it('waits for an in-flight Stop, submits Start, then waits for STARTED', async () => {
    const { service, admittedBox, boxService, waiter } = makeHarness({
      id: 'box-1',
      state: BoxState.STOPPING,
      desiredState: BoxDesiredState.STOPPED,
    })
    boxService.ensureStartedForProxy.mockResolvedValueOnce({
      id: 'box-1',
      state: BoxState.STOPPING,
      desiredState: BoxDesiredState.STOPPED,
    })
    boxService.ensureStartedForProxy.mockResolvedValueOnce({
      id: 'box-1',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady(admittedBox, organization)

    expect(waiter.waitForStopped).toHaveBeenCalledWith('box-1', 'org-1', 30)
    expect(waiter.waitForStarted).toHaveBeenCalledWith('box-1', 'org-1', 30, expect.any(Function))
    expect(boxService.ensureStartedForProxy).toHaveBeenCalledTimes(2)
    expect(observed.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
  })

  it('propagates timeout or transition failures', async () => {
    const { service, admittedBox, waiter } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTING,
      desiredState: BoxDesiredState.STARTED,
    })
    waiter.waitForStarted.mockRejectedValue(new RequestTimeoutException('start timeout'))

    await expect(service.ensureReady(admittedBox, organization)).rejects.toThrow('start timeout')
    expect(observed[1]['operation.result']).toBe('timeout')
  })

  it('includes lifecycle-lock waiting in timeout accounting', async () => {
    jest.useFakeTimers()
    const { service, admittedBox, redisLockProvider, boxService } = makeHarness({
      id: 'box-1',
      state: BoxState.STOPPED,
    })
    redisLockProvider.lock.mockResolvedValue(false)
    const pending = service.ensureReady(admittedBox, organization).catch((error) => error)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(await pending).toBeInstanceOf(RequestTimeoutException)
    expect(boxService.ensureStartedForProxy).not.toHaveBeenCalled()
    expect(observed[1]).toMatchObject({ 'operation.result': 'timeout', 'operation.duration_ms': '30000' })
    expect(observed[0]['operation.requested_at']).toBe(observed[1]['operation.requested_at'])
  })
})
