/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

import { BoxStartAction } from './box-start.action'
import { BoxAction, SYNC_AGAIN } from './box.action'
import { Box } from '../../entities/box.entity'
import { Runner } from '../../entities/runner.entity'
import { BoxState } from '../../enums/box-state.enum'
import { BoxDesiredState } from '../../enums/box-desired-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { LockCode } from '../../common/redis-lock.provider'

describe('BoxStartAction.handleRunnerBoxStoppedStateOnDesiredStateStart', () => {
  it('restarts a stopped box on its own runner (no cross-runner reassignment)', async () => {
    const ownRunnerId = 'runner-own-1'

    const box = new Box('region-1', 'my-box')
    box.runnerId = ownRunnerId
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const ownRunner = { id: ownRunnerId, state: RunnerState.READY, apiVersion: '2' } as Runner

    // findOneOrFail must return the runner that matches the requested id so we can
    // prove the action selected box.runnerId and nothing else.
    const runnerService = {
      findOneOrFail: jest.fn(async (id: string) => {
        if (id !== ownRunnerId) {
          throw new Error(`unexpected runner lookup: ${id}`)
        }
        return ownRunner
      }),
    }

    // Capture the runner the action chose to start the box on.
    let runnerUsedForStart: Runner | undefined
    const startBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = {
      create: jest.fn(async (runner: Runner) => {
        runnerUsedForStart = runner
        return { startBox } as any
      }),
    }

    const lockCode = new LockCode('lock-1')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      findOne: jest.fn(async () => box),
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const redisLockProvider = {
      getCode: jest.fn(async () => lockCode),
    }
    const organizationService = {
      findOne: jest.fn(async () => ({ boxMetadata: {} })),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any, // configService
      redisLockProvider as any,
      {} as any, // boxActivityService
    )

    const result = await (action as BoxAction).run(box, lockCode)

    // The action started the box on its OWN runner, not a different one.
    expect(runnerUsedForStart?.id).toBe(ownRunnerId)
    expect(startBox).toHaveBeenCalledWith(box.id, box.authToken, expect.any(Object))
    // findOneOrFail was only ever asked about the box's own runner.
    for (const call of runnerService.findOneOrFail.mock.calls) {
      expect(call[0]).toBe(ownRunnerId)
    }
    expect(result).toBe(SYNC_AGAIN)
    expect(updatedFields.some((u) => u.state === BoxState.STARTING)).toBe(true)
  })

  it('moves a stopped box with no runner to ERROR (cross-runner recovery is not supported)', async () => {
    const box = new Box('region-1', 'orphan-box')
    box.runnerId = null
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runnerService = { findOneOrFail: jest.fn() }
    const runnerAdapterFactory = { create: jest.fn() }
    const lockCode = new LockCode('lock-2')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      findOne: jest.fn(async () => box),
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    // No runner lookup or adapter creation: there is no runner to recover onto.
    expect(runnerService.findOneOrFail).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
  })

  it('rejects a v0 runner before invoking the external start side effect', async () => {
    const box = new Box('region-1', 'legacy-box')
    Object.assign(box, {
      runnerId: 'runner-v0',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const runnerService = {
      findOneOrFail: jest.fn(async () => ({
        id: 'runner-v0',
        state: RunnerState.READY,
        apiVersion: '0',
      })),
    }
    const runnerAdapterFactory = { create: jest.fn() }
    const lockCode = new LockCode('lock-v0')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      { findOne: jest.fn() } as any,
      {} as any,
      { getCode: jest.fn(async () => lockCode) } as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(updatedFields).toContainEqual(
      expect.objectContaining({
        state: BoxState.ERROR,
        errorReason: expect.stringContaining('cannot prove actual runtime state'),
      }),
    )
  })
})

describe('BoxStartAction.handleRunnerBoxUnknownStateOnDesiredStateStart', () => {
  it('boots an unknown box via runnerAdapter.createBox and moves it to CREATING', async () => {
    const runnerId = 'runner-boot-1'

    const box = new Box('region-1', 'fresh-box')
    box.runnerId = runnerId
    box.image = 'boxlite/base'
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY, apiVersion: '2' } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }

    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }

    const lockCode = new LockCode('lock-boot-1')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      findOne: jest.fn(async () => box),
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
    )

    const result = await (action as BoxAction).run(box, lockCode)

    expect(createBox).toHaveBeenCalledWith(box, expect.any(Object))
    expect(result).toBe(SYNC_AGAIN)
    expect(updatedFields.some((u) => u.state === BoxState.CREATING)).toBe(true)
  })

  it('moves an unknown box with no image to ERROR without calling createBox', async () => {
    const runnerId = 'runner-boot-2'

    const box = new Box('region-1', 'imageless-box')
    box.runnerId = runnerId
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY, apiVersion: '2' } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }

    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }

    const lockCode = new LockCode('lock-boot-2')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(createBox).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
  })
})

describe('BoxStartAction previous runner cleanup', () => {
  it('does not create a destructive lifecycle job when the previous runner is v2', async () => {
    const currentRunnerId = 'runner-current'
    const previousRunnerId = 'runner-previous'
    const box = new Box('region-1', 'transferred-box')
    Object.assign(box, {
      runnerId: currentRunnerId,
      prevRunnerId: previousRunnerId,
      state: BoxState.STARTING,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
      runtimeGeneration: 8,
      runtimeAuthorized: false,
      lifecycleJobId: 'current-start-job',
    })
    const currentRunner = {
      id: currentRunnerId,
      apiVersion: '2',
      state: RunnerState.READY,
    } as Runner
    const previousRunner = {
      id: previousRunnerId,
      apiVersion: '2',
      state: RunnerState.READY,
    } as Runner
    const runnerService = {
      findOneOrFail: jest.fn(async () => currentRunner),
      findOne: jest.fn(async () => previousRunner),
    }
    const destroyBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = {
      create: jest.fn(async (runner: Runner) =>
        runner.id === currentRunnerId
          ? ({ boxInfo: jest.fn(async () => ({ state: BoxState.STARTED })) } as any)
          : ({ destroyBox } as any),
      ),
    }
    const lockCode = new LockCode('lock-transfer')
    const boxRepository = {
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        Object.assign(box, opts.updateData)
        return box
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      {} as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(destroyBox).not.toHaveBeenCalled()
    expect(box.prevRunnerId).toBeNull()
    expect(box.runtimeGeneration).toBe(8)
    expect(box.lifecycleJobId).toBe('current-start-job')
  })
})
