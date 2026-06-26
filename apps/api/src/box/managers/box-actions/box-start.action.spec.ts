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

    const ownRunner = { id: ownRunnerId, state: RunnerState.READY } as Runner

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
      { get: jest.fn(async () => null), del: jest.fn(async () => 1) } as any,
      { decrypt: jest.fn(async (value: string) => value) } as any,
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
      { get: jest.fn(async () => null), del: jest.fn(async () => 1) } as any,
      { decrypt: jest.fn(async (value: string) => value) } as any,
    )

    await (action as BoxAction).run(box, lockCode)

    // No runner lookup or adapter creation: there is no runner to recover onto.
    expect(runnerService.findOneOrFail).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
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

    const runner = { id: runnerId, state: RunnerState.READY } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }

    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }

    const lockCode = new LockCode('lock-boot-1')
    const updatedFields: Partial<Box>[] = []
    const boxRepository = {
      update: jest.fn(async (_id: string, opts: { updateData: Partial<Box> }) => {
        updatedFields.push(opts.updateData)
        return box
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }
    const redis = { get: jest.fn(async () => null), del: jest.fn(async () => 1) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      redis as any,
      { decrypt: jest.fn(async (value: string) => value) } as any,
    )

    const result = await (action as BoxAction).run(box, lockCode)

    expect(createBox).toHaveBeenCalledWith(box, expect.any(Object), [])
    expect(redis.del).toHaveBeenCalledWith(`box:create-secrets:${box.id}`)
    expect(result).toBe(SYNC_AGAIN)
    expect(updatedFields.some((u) => u.state === BoxState.CREATING)).toBe(true)
  })

  it('loads encrypted create secrets from Redis before creating the runner box', async () => {
    const runnerId = 'runner-boot-secret'

    const box = new Box('region-1', 'secret-box')
    box.runnerId = runnerId
    box.image = 'boxlite/base'
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }
    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }
    const lockCode = new LockCode('lock-boot-secret')
    const boxRepository = { update: jest.fn(async () => box) }
    const redisLockProvider = { getCode: jest.fn(async () => lockCode) }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }
    const redis = {
      get: jest.fn(async () =>
        JSON.stringify([
          {
            name: 'openai_api_key',
            value: 'encrypted:sk-test',
            hosts: ['api.openai.com'],
            placeholder: '<BOXLITE_SECRET:openai_api_key>',
          },
        ]),
      ),
      del: jest.fn(async () => 1),
    }
    const encryptionService = {
      decrypt: jest.fn(async (value: string) => value.replace('encrypted:', '')),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      redis as any,
      encryptionService as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(createBox).toHaveBeenCalledWith(box, expect.any(Object), [
      {
        name: 'openai_api_key',
        value: 'sk-test',
        hosts: ['api.openai.com'],
        placeholder: '<BOXLITE_SECRET:openai_api_key>',
      },
    ])
    expect(encryptionService.decrypt).toHaveBeenCalledWith('encrypted:sk-test')
    expect(redis.del).toHaveBeenCalledWith(`box:create-secrets:${box.id}`)
  })

  it('keeps stored secrets when the creating state update fails after runner create dispatch', async () => {
    const runnerId = 'runner-boot-3'

    const box = new Box('region-1', 'retry-box')
    box.runnerId = runnerId
    box.image = 'boxlite/base'
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }
    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }
    const boxRepository = {
      update: jest.fn(async () => {
        throw new Error('state update failed')
      }),
    }
    const redisLockProvider = { getCode: jest.fn(async () => new LockCode('lock-boot-3')) }
    const redis = {
      get: jest.fn(async () =>
        JSON.stringify([
          {
            name: 'openai_api_key',
            value: 'encrypted:sk-test',
            hosts: ['api.openai.com'],
            placeholder: '<BOXLITE_SECRET:openai_api_key>',
          },
        ]),
      ),
      del: jest.fn(async () => 1),
    }
    const encryptionService = {
      decrypt: jest.fn(async (value: string) => value.replace('encrypted:', '')),
    }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      redis as any,
      encryptionService as any,
    )

    await expect(action.run(box, new LockCode('lock-boot-3'))).rejects.toThrow('state update failed')

    expect(createBox).toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('fails closed when stored create secrets are malformed', async () => {
    const runnerId = 'runner-boot-4'

    const box = new Box('region-1', 'bad-secret-box')
    box.runnerId = runnerId
    box.image = 'boxlite/base'
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY } as Runner
    const runnerService = { findOneOrFail: jest.fn(async () => runner) }
    const createBox = jest.fn(async () => undefined)
    const runnerAdapterFactory = { create: jest.fn(async () => ({ createBox }) as any) }
    const boxRepository = { update: jest.fn(async () => box) }
    const redisLockProvider = { getCode: jest.fn(async () => new LockCode('lock-boot-4')) }
    const redis = {
      get: jest.fn(async () => '{not-json'),
      del: jest.fn(async () => 1),
    }
    const encryptionService = {
      decrypt: jest.fn(async (value: string) => value),
    }
    const organizationService = { findOne: jest.fn(async () => ({ boxMetadata: {} })) }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
      redis as any,
      encryptionService as any,
    )

    await expect(action.run(box, new LockCode('lock-boot-4'))).rejects.toThrow(
      `Invalid create secrets payload for box ${box.id}`,
    )

    expect(createBox).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('moves an unknown box with no image to ERROR without calling createBox', async () => {
    const runnerId = 'runner-boot-2'

    const box = new Box('region-1', 'imageless-box')
    box.runnerId = runnerId
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true

    const runner = { id: runnerId, state: RunnerState.READY } as Runner
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
      { get: jest.fn(async () => null), del: jest.fn(async () => 1) } as any,
      { decrypt: jest.fn(async (value: string) => value) } as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(createBox).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
  })
})
