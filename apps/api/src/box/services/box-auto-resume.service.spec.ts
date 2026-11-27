/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

const organization = { id: 'org-1', suspended: false } as any

function makeHarness(initial: Record<string, unknown>) {
  const boxService = {
    ensureStartedForProxy: jest.fn().mockResolvedValue(initial),
    assertOrganizationIsNotSuspended: jest.fn(),
  }
  const waiter = {
    waitForStarted: jest.fn().mockResolvedValue({ state: BoxState.STARTED }),
    waitForStopped: jest.fn().mockResolvedValue({ state: BoxState.STOPPED }),
  }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  return {
    service: new BoxAutoResumeService(boxService as never, waiter as never, redisLockProvider as never),
    boxService,
    waiter,
    redisLockProvider,
  }
}

describe('BoxAutoResumeService', () => {
  it('reuses an already running snapshot without a second Box read or Redis lock', async () => {
    const box = {
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    }
    const { service, boxService, waiter, redisLockProvider } = makeHarness(box)

    await service.ensureReady('box-1', organization, undefined, box as any)

    expect(boxService.assertOrganizationIsNotSuspended).toHaveBeenCalledWith(organization)
    expect(boxService.ensureStartedForProxy).not.toHaveBeenCalled()
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
    expect(redisLockProvider.lock).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })

  it('uses the locked resume path when the snapshot is no longer desired STARTED', async () => {
    const box = {
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STOPPED,
    }
    const { service, boxService, redisLockProvider } = makeHarness(box)

    await service.ensureReady('box-1', organization, undefined, box as any)

    expect(boxService.ensureStartedForProxy).toHaveBeenCalled()
    expect(redisLockProvider.lock).toHaveBeenCalled()
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
