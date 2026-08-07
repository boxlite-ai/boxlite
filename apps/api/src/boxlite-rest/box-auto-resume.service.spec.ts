/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'

const organization = { id: 'org-1', suspended: false } as any

function makeHarness(initial: Record<string, unknown>) {
  const boxService = { ensureStartedForProxy: jest.fn().mockResolvedValue(initial) }
  const waiter = {
    waitForStarted: jest.fn().mockResolvedValue({ state: BoxState.STARTED }),
    waitForStopped: jest.fn().mockResolvedValue({ state: BoxState.STOPPED }),
  }
  const redisLockProvider = {
    acquireLease: jest.fn(),
  }
  const release = jest.fn().mockResolvedValue(undefined)
  redisLockProvider.acquireLease.mockResolvedValue({ release })
  return {
    service: new BoxAutoResumeService(boxService as never, waiter as never, redisLockProvider as never),
    boxService,
    waiter,
    redisLockProvider,
    release,
  }
}

describe('BoxAutoResumeService', () => {
  it('returns immediately for an already STARTED box', async () => {
    const { service, waiter, redisLockProvider, release } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady('box-1', organization)
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
    expect(redisLockProvider.acquireLease).toHaveBeenCalledWith('box:box-1:state-change', 30)
    expect(release).toHaveBeenCalled()
  })

  it('joins an in-flight Start and waits for STARTED', async () => {
    const { service, waiter } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTING,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady('box-1', organization)
    expect(waiter.waitForStarted).toHaveBeenCalledWith('box-1', 'org-1', 30)
  })

  it('waits for an in-flight Stop, submits Start, then waits for STARTED', async () => {
    const { service, boxService, waiter } = makeHarness({
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

    await service.ensureReady('box-1', organization)

    expect(waiter.waitForStopped).toHaveBeenCalledWith('box-1', 'org-1', 30)
    expect(waiter.waitForStarted).toHaveBeenCalledWith('box-1', 'org-1', 30)
    expect(boxService.ensureStartedForProxy).toHaveBeenCalledTimes(2)
  })

  it('propagates timeout or transition failures', async () => {
    const { service, waiter } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTING,
      desiredState: BoxDesiredState.STARTED,
    })
    waiter.waitForStarted.mockRejectedValue(new Error('start timeout'))

    await expect(service.ensureReady('box-1', organization)).rejects.toThrow('start timeout')
  })
})
