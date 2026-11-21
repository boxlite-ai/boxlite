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
import { BoxAction, DONT_SYNC_AGAIN, SYNC_AGAIN } from './box.action'
import { Box } from '../../entities/box.entity'
import { Runner } from '../../entities/runner.entity'
import { BoxState } from '../../enums/box-state.enum'
import { BoxDesiredState } from '../../enums/box-desired-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { LockCode } from '../../common/redis-lock.provider'
import { RunnerAdapterV0 } from '../../runner-adapter/runnerAdapter.v0'
import { ServiceUnavailableException } from '@nestjs/common'

describe('BoxStartAction.handleRunnerBoxStoppedStateOnDesiredStateStart', () => {
  function stoppedFilestoreFixture(adapter: any) {
    const box = new Box('region-1', 'filestore-box')
    box.runnerId = 'runner-1'
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true
    box.volumes = [
      {
        volumeId: 'volume-1',
        mountPath: '/data',
        filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
      },
    ] as any
    const lockCode = new LockCode('lock-filestore-start')
    const update = jest.fn(async () => box)
    const filestoreInstanceResolver = {
      resolve: jest.fn().mockResolvedValue({ server: '10.0.0.9', export: '/vol2' }),
    }
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn(async () => ({ id: 'runner-1', state: RunnerState.READY })) } as any,
      { create: jest.fn(async () => adapter) } as any,
      { update } as any,
      { findOne: jest.fn(async () => ({ boxMetadata: {} })) } as any,
      { getOrThrow: () => 1 } as any,
      { getCode: jest.fn(async () => lockCode) } as any,
      {} as any,
      {} as any,
      filestoreInstanceResolver as any,
    )
    return { box, lockCode, action, update, filestoreInstanceResolver }
  }

  it('does not dispatch a restart after the runner loses Filestore capability', async () => {
    const capabilityError = Object.assign(new Error('FILESTORE_CAPABILITY_MISSING'), {
      code: 'FILESTORE_CAPABILITY_MISSING',
    })
    const assertFilestoreVolumeSupport = jest.fn().mockRejectedValue(capabilityError)
    const startBox = jest.fn(async () => undefined)
    const { box, lockCode, action } = stoppedFilestoreFixture({ assertFilestoreVolumeSupport, startBox })

    await expect((action as BoxAction).run(box, lockCode)).rejects.toBe(capabilityError)
    expect(assertFilestoreVolumeSupport).toHaveBeenCalledWith(expect.objectContaining({ id: box.id }))
    expect(startBox).not.toHaveBeenCalled()
  })

  it('does not send a Filestore restart to a v0 runner', async () => {
    const adapter = new RunnerAdapterV0()
    await adapter.init({ id: 'runner-1', apiVersion: '0', apiUrl: 'http://runner.invalid' } as any)
    const start = jest.fn().mockResolvedValue({ data: {} })
    ;(adapter as any).boxApiClient = { start }
    const { box, lockCode, action } = stoppedFilestoreFixture(adapter)

    await expect((action as BoxAction).run(box, lockCode)).rejects.toThrow(/requires a v2 runner/)
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps a stopped box retryable when Filestore resolution is temporarily unavailable', async () => {
    const startBox = jest.fn(async () => undefined)
    const { box, lockCode, action, update, filestoreInstanceResolver } = stoppedFilestoreFixture({
      startBox,
      assertFilestoreVolumeSupport: jest.fn(async () => undefined),
    })
    filestoreInstanceResolver.resolve
      .mockRejectedValueOnce(new ServiceUnavailableException('temporary GCP outage'))
      .mockResolvedValueOnce({ server: '10.0.0.9', export: '/vol2' })

    await expect((action as BoxAction).run(box, lockCode)).resolves.toBe(DONT_SYNC_AGAIN)
    expect(startBox).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(box.state).toBe(BoxState.STOPPED)

    await expect((action as BoxAction).run(box, lockCode)).resolves.toBe(SYNC_AGAIN)
    expect(startBox).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      box.id,
      expect.objectContaining({ updateData: expect.objectContaining({ state: BoxState.STARTING }) }),
    )
  })

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
        return { startBox, assertFilestoreVolumeSupport: jest.fn(async () => undefined) } as any
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
      isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      { getOrThrow: () => 1 } as any, // configService
      redisLockProvider as any,
      {} as any, // boxActivityService
      {} as any, // curatedImagePins
      {} as any,
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

  it('re-resolves the filestore target in the start metadata of a restarted box', async () => {
    const ownRunnerId = 'runner-own-1'

    const box = new Box('region-1', 'my-box')
    box.runnerId = ownRunnerId
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true
    box.volumes = [
      {
        volumeId: 'volume-1',
        mountPath: '/data',
        filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
      },
    ] as any

    const ownRunner = { id: ownRunnerId, state: RunnerState.READY } as Runner
    const runnerService = {
      findOneOrFail: jest.fn(async (id: string) => {
        if (id !== ownRunnerId) {
          throw new Error(`unexpected runner lookup: ${id}`)
        }
        return ownRunner
      }),
    }

    const startBox = jest.fn(async (_boxId: string, _token: string, _metadata: Record<string, string>) => undefined)
    const runnerAdapterFactory = {
      create: jest.fn(async () => ({ startBox, assertFilestoreVolumeSupport: jest.fn(async () => undefined) }) as any),
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
      { getOrThrow: () => 1 } as any, // configService
      redisLockProvider as any,
      {} as any, // boxActivityService
      {} as any, // curatedImagePins
      {} as any,
    )
    const filestoreInstanceResolver = {
      resolve: jest.fn().mockResolvedValue({ server: '10.0.0.9', export: '/vol2' }),
    }
    Object.assign(action, { filestoreInstanceResolver })

    await (action as BoxAction).run(box, lockCode)

    expect(filestoreInstanceResolver.resolve).toHaveBeenCalledWith('ml-scratch', 'configured')
    const metadata = startBox.mock.calls[0][2] as { volumes: string }
    const volumes = JSON.parse(metadata['volumes'])
    expect(volumes).toEqual([
      {
        volumeId: 'volume-1',
        mountPath: '/data',
        subpath: undefined,
        filestore: { instance: 'ml-scratch', server: '10.0.0.9', export: '/vol2' },
      },
    ])
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
    const organizationService = {
      findOne: jest.fn(async () => ({ boxMetadata: {} })),
      isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      { getOrThrow: () => 1 } as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    // No runner lookup or adapter creation: there is no runner to recover onto.
    expect(runnerService.findOneOrFail).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
  })
})

describe('BoxStartAction.handleRunnerBoxUnknownStateOnDesiredStateStart', () => {
  it('uses the refreshed Filestore target in both the create payload and start metadata', async () => {
    const box = new Box('region-1', 'filestore-create')
    box.runnerId = 'runner-1'
    box.image = 'boxlite/base'
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED
    box.pending = true
    box.volumes = [
      {
        volumeId: 'volume-1',
        mountPath: '/data',
        filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
      },
    ] as any
    const createBox: jest.Mock = jest.fn(async () => undefined)
    const lockCode = new LockCode('lock-filestore-create')
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn(async () => ({ id: 'runner-1', state: RunnerState.READY })) } as any,
      { create: jest.fn(async () => ({ createBox })) } as any,
      { update: jest.fn(async () => box) } as any,
      {
        findOne: jest.fn(async () => ({ boxMetadata: {} })),
        isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
      } as any,
      { getOrThrow: () => 1 } as any,
      { getCode: jest.fn(async () => lockCode) } as any,
      {} as any,
      { refFor: jest.fn(async (_runnerId, image) => image) } as any,
      { resolve: jest.fn().mockResolvedValue({ server: '10.0.0.9', export: '/vol2' }) } as any,
    )

    await (action as BoxAction).run(box, lockCode)

    const [dispatchBox, , metadata] = createBox.mock.calls[0]
    const refreshed = { instance: 'ml-scratch', server: '10.0.0.9', export: '/vol2' }
    expect(dispatchBox.volumes[0].filestore).toEqual(refreshed)
    expect(JSON.parse(metadata.volumes)[0].filestore).toEqual(refreshed)
    expect(box.volumes[0].filestore.server).toBe('10.0.0.7')
  })

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
    const organizationService = {
      findOne: jest.fn(async () => ({ boxMetadata: {} })),
      isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      { getOrThrow: () => 1 } as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const result = await (action as BoxAction).run(box, lockCode)

    expect(createBox).toHaveBeenCalledWith(box, 'boxlite/base', expect.any(Object), false)
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
    const organizationService = {
      findOne: jest.fn(async () => ({ boxMetadata: {} })),
      isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
    }

    const action = new BoxStartAction(
      runnerService as any,
      runnerAdapterFactory as any,
      boxRepository as any,
      organizationService as any,
      { getOrThrow: () => 1 } as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)

    expect(createBox).not.toHaveBeenCalled()
    expect(updatedFields.some((u) => u.state === BoxState.ERROR)).toBe(true)
  })
})

describe('BoxStartAction image dispatch', () => {
  const CURATED = 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0'
  const PINNED = `ghcr.io/boxlite-ai/boxlite-agent-base@sha256:${'a'.repeat(64)}`

  async function dispatch(image: string, imageIsOrgOwned: boolean) {
    const box = new Box('region-1', 'fresh-box')
    box.runnerId = 'runner-1'
    box.image = image
    box.imageIsOrgOwned = imageIsOrgOwned
    box.state = BoxState.UNKNOWN
    box.desiredState = BoxDesiredState.STARTED

    const createBox = jest.fn(async () => undefined)
    const curatedImagePins = { refFor: jest.fn(async () => PINNED) }
    const lockCode = new LockCode('lock-dispatch')
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn(async () => ({ id: 'runner-1', state: RunnerState.READY })) } as any,
      { create: jest.fn(async () => ({ createBox })) } as any,
      { update: jest.fn(async () => box) } as any,
      {
        findOne: jest.fn(async () => ({ boxMetadata: {} })),
        isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
      } as any,
      { getOrThrow: () => 1 } as any,
      { getCode: jest.fn(async () => lockCode) } as any,
      {} as any,
      curatedImagePins as any,
      {} as any,
    )

    await (action as BoxAction).run(box, lockCode)
    return { box, createBox, curatedImagePins }
  }

  /**
   * A runner re-resolves a tag for every new disk. Handing it the build it
   * already booted is what keeps a curated box on that runner's cache.
   */
  it('hands the runner the build it already booted for a curated tag', async () => {
    const { box, createBox, curatedImagePins } = await dispatch(CURATED, false)

    expect(curatedImagePins.refFor).toHaveBeenCalledWith('runner-1', CURATED)
    expect(createBox).toHaveBeenCalledWith(box, PINNED, expect.any(Object), false)
    expect(box.image).toBe(CURATED)
  })

  it('hands a tenant image over as the resolver left it', async () => {
    const { box, createBox, curatedImagePins } = await dispatch('quay.io/acme/app:v1', true)

    expect(curatedImagePins.refFor).not.toHaveBeenCalled()
    expect(createBox).toHaveBeenCalledWith(box, 'quay.io/acme/app:v1', expect.any(Object), false)
  })
})
