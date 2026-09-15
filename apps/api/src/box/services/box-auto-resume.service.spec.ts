/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxAutoResumeService } from './box-auto-resume.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

const organization = { id: 'org-1', suspended: false } as any

function makeHarness(initial: Record<string, unknown>, gate: Record<string, unknown> = {}) {
  const boxService = {
    ensureStartedForProxy: jest.fn().mockResolvedValue(initial),
    // What the eligibility gate reads. Defaults to the box under test with
    // auto-resume on, so existing cases exercise the resume itself.
    findOneByIdOrName: jest.fn().mockResolvedValue({ autoResume: true, ...initial, ...gate }),
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
  it('returns immediately for an already STARTED box', async () => {
    const { service, waiter, redisLockProvider } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureReady('box-1', organization)
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
    expect(redisLockProvider.lock.mock.calls).toEqual([['box:box-1:state-change', 30]])
    expect(redisLockProvider.unlock.mock.calls).toEqual([['box:box-1:state-change']])
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

describe('BoxAutoResumeService eligibility', () => {
  it('refuses a box whose owner turned auto-resume off', async () => {
    // The flag is the owner's off switch for exactly this: traffic arriving at
    // a preview URL must not spend their compute. Enforced here rather than in
    // each caller, so no entry point can forget it.
    const { service, boxService, redisLockProvider } = makeHarness(
      { id: 'box-1', state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED },
      { autoResume: false },
    )

    await expect(service.ensureReady('box-1', organization)).rejects.toMatchObject({ status: 409 })
    expect(boxService.ensureStartedForProxy).not.toHaveBeenCalled()
    expect(redisLockProvider.lock).not.toHaveBeenCalled()
  })

  it.each([
    BoxState.ERROR,
    BoxState.ARCHIVED,
    BoxState.ARCHIVING,
    BoxState.DESTROYING,
    BoxState.RESIZING,
    BoxState.UNKNOWN,
  ])('refuses state %s instead of waiting out the resume window', async (state) => {
    // None of these reach STARTED on their own, so the caller would pay the
    // full 30s only to fail — worse than being told now.
    const { service, boxService } = makeHarness({ id: 'box-1', state, desiredState: BoxDesiredState.STARTED })

    await expect(service.ensureReady('box-1', organization)).rejects.toMatchObject({ status: 409 })
    expect(boxService.ensureStartedForProxy).not.toHaveBeenCalled()
  })

  it('still resumes a STARTED box that is on its way to STOPPED', async () => {
    // Not a non-running state, but not settled either: ensureReady waits out
    // the stop and starts it again, so the gate must let it through.
    const { service, boxService } = makeHarness({
      id: 'box-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STOPPED,
    })

    await service.ensureReady('box-1', organization)
    expect(boxService.ensureStartedForProxy).toHaveBeenCalled()
  })

  it('lets a settled running box through without consulting auto-resume', async () => {
    // Nothing is being started, so the owner's switch has nothing to authorize.
    const { service } = makeHarness(
      { id: 'box-1', state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED },
      { autoResume: false },
    )

    await expect(service.ensureReady('box-1', organization)).resolves.toBeUndefined()
  })
})
