/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxManager } from './box.manager'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'

// Job's constructor calls uuid's v4(), which needs a global WebCrypto the node-18
// jest env doesn't expose. Mock it like the other box specs (e.g.
// box-start.action.spec) so constructing a Job in the code under test stays
// deterministic and crypto-free.
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid') }))

// Guards the reconcile retry ceiling: when a START_BOX sync throws *before* a
// START_BOX job is ever persisted (synchronous runner lookup / adapter failure),
// syncInstanceState must record a terminal FAILED START_BOX job so the ceiling —
// which counts FAILED START_BOX jobs — can see the attempt. Otherwise the box is
// flipped out of ERROR forever.
function buildHarness(opts: {
  box: { state: BoxState; desiredState: BoxDesiredState; runnerId: string | null }
  failingAction: 'start' | 'stop'
}) {
  const box = { id: 'box-1', ...opts.box } as any

  const insert = jest.fn().mockResolvedValue(undefined)
  const updateWhere = jest.fn().mockResolvedValue(undefined)

  const boxRepository: any = {
    findOneOrFail: jest.fn().mockResolvedValue(box),
    updateWhere,
  }
  const runnerService: any = {
    getRunnerApiVersion: jest.fn().mockResolvedValue('2'),
  }
  const redisLockProvider: any = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
    isLocked: jest.fn().mockResolvedValue(false),
  }
  const thrower = jest.fn().mockRejectedValue(new Error('runner unreachable'))
  const boxStartAction: any = { run: opts.failingAction === 'start' ? thrower : jest.fn() }
  const boxStopAction: any = { run: opts.failingAction === 'stop' ? thrower : jest.fn() }
  const boxDestroyAction: any = { run: jest.fn() }
  const jobRepository: any = { insert, count: jest.fn().mockResolvedValue(0) }

  const manager = new BoxManager(
    boxRepository,
    runnerService,
    redisLockProvider,
    boxStartAction,
    boxStopAction,
    boxDestroyAction,
    jobRepository,
  )
  return { manager, insert, updateWhere }
}

describe('BoxManager.syncInstanceState — failed START_BOX accounting', () => {
  afterEach(() => jest.clearAllMocks())

  it('records a terminal FAILED START_BOX job when a STARTED sync throws before a job is persisted', async () => {
    const { manager, insert, updateWhere } = buildHarness({
      box: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STARTED, runnerId: 'runner-1' },
      failingAction: 'start',
    })

    await manager.syncInstanceState('box-1')

    // The box is still transitioned to ERROR ...
    expect(updateWhere).toHaveBeenCalledTimes(1)
    // ... and a FAILED START_BOX job is recorded so the reconcile ceiling counts it.
    expect(insert).toHaveBeenCalledTimes(1)
    const job = insert.mock.calls[0][0]
    expect(job).toMatchObject({
      type: JobType.START_BOX,
      status: JobStatus.FAILED,
      resourceId: 'box-1',
      runnerId: 'runner-1',
    })
    // completedAt set => row stays outside the "one incomplete job per box" partial-unique index.
    expect(job.completedAt).toBeInstanceOf(Date)
  })

  it('does not record a START_BOX job when the failing sync is not a START (e.g. STOPPED)', async () => {
    const { manager, insert, updateWhere } = buildHarness({
      box: { state: BoxState.STARTED, desiredState: BoxDesiredState.STOPPED, runnerId: 'runner-1' },
      failingAction: 'stop',
    })

    await manager.syncInstanceState('box-1')

    expect(updateWhere).toHaveBeenCalledTimes(1) // still transitions to ERROR
    expect(insert).not.toHaveBeenCalled() // but no synthetic START_BOX job
  })

  it('skips the synthetic job when the box has no runner', async () => {
    const { manager, insert } = buildHarness({
      box: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STARTED, runnerId: null },
      failingAction: 'start',
    })

    await manager.syncInstanceState('box-1')

    expect(insert).not.toHaveBeenCalled()
  })
})
