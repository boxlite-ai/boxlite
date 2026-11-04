import { Box } from './entities/box.entity'
import { BoxState } from './enums/box-state.enum'
import { BoxDesiredState } from './enums/box-desired-state.enum'
import { RunnerState } from './enums/runner-state.enum'
import { BoxStartAction } from './managers/box-actions/box-start.action'
import { LockCode } from './common/redis-lock.provider'
import { BoxService } from './services/box.service'
import { JobStateHandlerService } from './services/job-state-handler.service'
import { Job } from './entities/job.entity'
import { JobStatus } from './enums/job-status.enum'
import { JobType } from './enums/job-type.enum'
import { ResourceType } from './enums/resource-type.enum'
import { BoxMigrationManager } from './managers/box-migration.manager'
import { BoxMigrationState } from './enums/box-migration-state.enum'

function pendingBox(state: BoxState) {
  return Object.assign(new Box('local', 'nested-worker'), {
    state,
    desiredState: BoxDesiredState.STARTED,
    pending: true,
    nestedVirtualization: true,
    runnerId: 'runner-1',
    organizationId: 'org-1',
    image: 'alpine:latest',
    imageIsOrgOwned: true,
  })
}

function actionFixture(box: Box, saved: boolean | undefined) {
  const runner = { id: box.runnerId, state: RunnerState.READY, apiVersion: '0' }
  const runnerService = {
    findOneOrFail: jest.fn().mockResolvedValue(runner),
    requireNestedVirtualization: jest.fn().mockResolvedValue(undefined),
  }
  const adapter = {
    boxInfo: jest.fn().mockResolvedValue({ state: BoxState.STARTED, nestedVirtualization: saved }),
    createBox: jest.fn().mockResolvedValue(undefined),
    startBox: jest.fn().mockResolvedValue(undefined),
  }
  const repository = { update: jest.fn().mockResolvedValue(box) }
  const lock = new LockCode('nested-lock')
  const action = new BoxStartAction(
    runnerService as never,
    { create: async () => adapter } as never,
    repository as never,
    { findOne: async () => ({ boxMetadata: {} }) } as never,
    {} as never,
    { getCode: async () => lock } as never,
    {} as never,
    {} as never,
  )
  return { action, lock, adapter, repository, runnerService }
}

describe('nested virtualization startup and reconciliation', () => {
  it('replays creation from saved intent and rechecks Runner authorization each time', async () => {
    const box = pendingBox(BoxState.UNKNOWN)
    const f = actionFixture(box, true)
    await f.action.run(box, f.lock)
    await f.action.run(box, f.lock)
    expect(f.runnerService.requireNestedVirtualization).toHaveBeenCalledTimes(2)
    expect(f.adapter.createBox).toHaveBeenCalledTimes(2)
    expect(f.adapter.createBox).toHaveBeenLastCalledWith(box, 'alpine:latest', {})
    expect(f.adapter.createBox.mock.calls[0][0].nestedVirtualization).toBe(true)
  })

  it.each([undefined, false, true])('requires saved %j confirmation before restarting', async (saved) => {
    const box = pendingBox(BoxState.STOPPED)
    const f = actionFixture(box, saved)
    if (saved === true) {
      await f.action.run(box, f.lock)
      expect(f.adapter.startBox).toHaveBeenCalledTimes(1)
      expect(f.repository.update).toHaveBeenCalledWith(
        box.id,
        expect.objectContaining({
          updateData: expect.objectContaining({ state: BoxState.STARTING }),
        }),
      )
    } else {
      await expect(f.action.run(box, f.lock)).rejects.toThrow(box.id)
      expect(f.adapter.startBox).not.toHaveBeenCalled()
      expect(f.repository.update).not.toHaveBeenCalled()
    }
  })

  it('refuses authorization rollback before start, without changing the saved requirement', async () => {
    const box = pendingBox(BoxState.STOPPED)
    const f = actionFixture(box, true)
    f.runnerService.requireNestedVirtualization.mockRejectedValue(new Error('operator disabled'))
    await expect(f.action.run(box, f.lock)).rejects.toThrow('operator disabled')
    expect(f.adapter.startBox).not.toHaveBeenCalled()
    expect(f.repository.update).not.toHaveBeenCalled()
    expect(box.nestedVirtualization).toBe(true)
  })

  it.each([undefined, false, true])('checks saved %j before accepting a STARTED poll', async (saved) => {
    const box = pendingBox(BoxState.CREATING)
    const f = actionFixture(box, saved)
    if (saved === true) {
      await f.action.run(box, f.lock)
      expect(f.repository.update).toHaveBeenCalledWith(
        box.id,
        expect.objectContaining({
          updateData: expect.objectContaining({ state: BoxState.STARTED }),
        }),
      )
    } else {
      await expect(f.action.run(box, f.lock)).rejects.toThrow(box.id)
      expect(f.repository.update).not.toHaveBeenCalled()
    }
    expect(f.adapter.startBox).not.toHaveBeenCalled()
    expect(f.adapter.createBox).not.toHaveBeenCalled()
  })

  it.each([undefined, false, true])('checks native saved %j before accepting a Runner state push', async (saved) => {
    const box = pendingBox(BoxState.STOPPED)
    box.pending = false
    const updateWhere = jest.fn().mockResolvedValue(box)
    const boxInfo = jest.fn().mockResolvedValue({ state: BoxState.STARTED, nestedVirtualization: saved })
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      boxRepository: { findOne: async () => box, updateWhere },
      runnerService: { findOneOrFail: async () => ({ apiVersion: '0' }) },
      runnerAdapterFactory: { create: async () => ({ boxInfo }) },
      logger: { debug() {} },
    })
    if (saved === true) {
      await service.updateState(box.id, BoxState.STARTED)
      expect(updateWhere).toHaveBeenCalledWith(
        box.id,
        expect.objectContaining({
          updateData: expect.objectContaining({ state: BoxState.STARTED }),
        }),
      )
    } else {
      await expect(service.updateState(box.id, BoxState.STARTED)).rejects.toThrow(box.id)
      expect(updateWhere).not.toHaveBeenCalled()
    }
    expect(boxInfo).toHaveBeenCalledWith(box.id)
  })
})

describe('nested virtualization recovery admission', () => {
  function recoveryFixture(saved: boolean | undefined) {
    const box = pendingBox(BoxState.ERROR)
    box.pending = false
    const requireNestedVirtualization = jest.fn().mockResolvedValue(undefined)
    const adapter = {
      recoverBox: jest.fn().mockResolvedValue(undefined),
      boxInfo: jest.fn().mockResolvedValue({ nestedVirtualization: saved }),
    }
    const updateWhere = jest.fn().mockResolvedValue(box)
    const start = jest.fn().mockResolvedValue(box)
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      findOneByIdOrName: async () => box,
      runnerService: { findOneOrFail: async () => ({ apiVersion: '0' }), requireNestedVirtualization },
      runnerAdapterFactory: { create: async () => adapter },
      boxRepository: { updateWhere },
      start,
    })
    return { box, service, adapter, requireNestedVirtualization, updateWhere, start }
  }

  it('rejects withdrawn authorization before issuing recovery', async () => {
    const f = recoveryFixture(true)
    f.requireNestedVirtualization.mockRejectedValue(new Error('operator disabled'))
    await expect(f.service.recover(f.box.id, { id: 'org' } as never)).rejects.toThrow('operator disabled')
    expect(f.adapter.recoverBox).not.toHaveBeenCalled()
    expect(f.updateWhere).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })

  it.each([undefined, false, true])('requires saved %j after recovery before the start transition', async (saved) => {
    const f = recoveryFixture(saved)
    if (saved === true) {
      await f.service.recover(f.box.id, { id: 'org' } as never)
      expect(f.updateWhere).toHaveBeenCalledTimes(1)
      expect(f.start).toHaveBeenCalledTimes(1)
    } else {
      await expect(f.service.recover(f.box.id, { id: 'org' } as never)).rejects.toThrow(f.box.id)
      expect(f.updateWhere).not.toHaveBeenCalled()
      expect(f.start).not.toHaveBeenCalled()
    }
    expect(f.adapter.recoverBox).toHaveBeenCalledWith(f.box)
  })
})

describe('nested virtualization V2 and archive exclusions', () => {
  it.each([JobType.CREATE_BOX, JobType.START_BOX])('never confirms nesting from a V2 %s completion', async (type) => {
    for (const claimed of [undefined, false, true]) {
      const box = pendingBox(BoxState.CREATING)
      const update = jest.fn().mockResolvedValue(box)
      const service = new JobStateHandlerService(
        { findOne: async () => box, update } as never,
        { unlock: async () => {} } as never,
        {} as never,
        {} as never,
      )
      const job = new Job({
        type,
        status: JobStatus.COMPLETED,
        runnerId: 'v2',
        resourceType: ResourceType.BOX,
        resourceId: box.id,
      })
      job.resultMetadata = JSON.stringify({ daemonVersion: 'v2', nestedVirtualization: claimed })
      await service.handleJobCompletion(job)
      expect(update).toHaveBeenCalledWith(
        box.id,
        expect.objectContaining({
          updateData: expect.objectContaining({ state: BoxState.ERROR, errorReason: expect.stringContaining(box.id) }),
        }),
      )
    }
  })

  it('submits no archive export job for a nested box', async () => {
    const box = pendingBox(BoxState.STOPPED)
    const migration = { boxId: box.id, box, state: BoxMigrationState.PENDING_EXPORT, isUndisturbedBy: () => true }
    const entityManager = { findOne: jest.fn().mockResolvedValueOnce(box).mockResolvedValueOnce(migration) }
    const createJob = jest.fn()
    const rollback = jest.fn().mockResolvedValue(undefined)
    const manager = Object.create(BoxMigrationManager.prototype)
    Object.assign(manager, {
      redisLockProvider: { lock: async () => true, unlock: async () => {} },
      dataSource: { transaction: (operation) => operation(entityManager) },
      jobService: { createJob },
      markRollback: rollback,
      logger: { warn() {}, error() {} },
    })
    await manager.submitValidated(migration, JobType.EXPORT_BOX, async () => ({ runnerId: 'runner-1' }))
    expect(rollback).toHaveBeenCalledWith(entityManager, migration)
    expect(createJob).not.toHaveBeenCalled()
  })
})
