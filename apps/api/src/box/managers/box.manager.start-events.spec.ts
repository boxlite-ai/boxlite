import { Logger } from '@nestjs/common'
import { BoxManager } from './box.manager'
import { BoxStartAction } from './box-actions/box-start.action'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxConflictError } from '../errors/box-conflict.error'
import { JobConflictError } from '../errors/job-conflict.error'
import { Box } from '../entities/box.entity'

describe('Legacy start terminal events', () => {
  let events: Array<Record<string, string>>
  beforeEach(() => {
    events = []
    const capture = (_message: unknown, attributes: Record<string, string>) => {
      if (attributes?.['event.name'] === 'box.start') events.push(attributes)
    }
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  function harness(version = '0', state = BoxState.STOPPED, reported = BoxState.STARTED) {
    const box = Object.assign(new Box('us'), {
      id: 'box-1',
      organizationId: 'org-1',
      runnerId: 'runner-1',
      state,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
      image: 'alpine',
      authToken: 'synthetic-token',
    })
    let lockCode: unknown
    const locks = {
      lock: jest.fn(async (_key, _ttl, code) => {
        lockCode = code
        return true
      }),
      getCode: jest.fn(async () => lockCode),
      unlock: jest.fn(),
    }
    const writes: BoxState[] = []
    const repository = {
      findOneOrFail: jest.fn(async () => box),
      update: jest.fn(async (_id, options) => {
        writes.push(options.updateData.state)
        Object.assign(options.entity, options.updateData)
        options.entity.enforceInvariants()
        return box
      }),
      updateWhere: jest.fn(async (_id, options) => {
        writes.push(options.updateData.state)
        Object.assign(box, options.updateData)
        box.enforceInvariants()
      }),
    }
    const runners = {
      findOneOrFail: jest.fn(async () => ({ id: box.runnerId, apiVersion: version, state: RunnerState.READY })),
      getRunnerApiVersion: jest.fn(async () => version),
    }
    const adapter = {
      startBox: jest.fn(async () => undefined),
      createBox: jest.fn(async () => undefined),
      boxInfo: jest.fn(async () => ({ state: reported })),
    }
    const activity = { getLastActivityAt: jest.fn(async () => new Date(Date.now() - 60 * 60 * 1000)) }
    const action = new BoxStartAction(
      runners as never,
      { create: async () => adapter } as never,
      repository as never,
      { findOne: async () => ({}) } as never,
      {} as never,
      locks as never,
      activity as never,
      { refFor: async (_runner, image) => image } as never,
    )
    const manager = new BoxManager(
      repository as never,
      runners as never,
      activity as never,
      locks as never,
      action,
      {} as never,
      {} as never,
      { reasonFor: async () => 'start failed' } as never,
    )
    return { manager, box, adapter, repository, writes, runners }
  }

  it('records success after persisted STARTED and does not repeat it on later syncs', async () => {
    const { manager, box, writes } = harness()
    await manager.syncInstanceState(box.id)
    expect(writes).toContain(BoxState.STARTED)
    expect(events).toEqual([
      expect.objectContaining({
        'event.outcome': 'success',
        'organization.id': 'org-1',
        'correlation.id': box.id,
      }),
    ])
    await manager.syncInstanceState(box.id)
    expect(events).toHaveLength(1)
  })

  it.each([BoxState.ERROR, BoxState.STARTING])('records a returned error or timeout once: %s', async (reported) => {
    const { manager, box, writes } = harness('0', BoxState.STARTING, reported)
    await manager.syncInstanceState(box.id)
    expect(writes).toContain(BoxState.ERROR)
    expect(events).toEqual([expect.objectContaining({ 'event.outcome': 'exception' })])
    await manager.syncInstanceState(box.id)
    expect(events).toHaveLength(1)
  })

  it('retains an existing start through runner instance loss and recreation', async () => {
    const { manager, box, adapter, writes } = harness('0', BoxState.STARTING)
    adapter.boxInfo.mockResolvedValueOnce({ state: BoxState.UNKNOWN })
    await manager.syncInstanceState(box.id)
    expect(adapter.createBox).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([BoxState.UNKNOWN, BoxState.CREATING, BoxState.STARTED])
    expect(events).toEqual([expect.objectContaining({ 'event.outcome': 'success' })])
  })

  it.each([BoxState.STARTED, BoxState.ERROR])('retains a start across sync invocations until %s', async (reported) => {
    jest.useFakeTimers()
    try {
      const { manager, box, adapter } = harness('0', BoxState.STARTING, reported)
      Object.assign(box, { startEventPending: true })
      adapter.boxInfo.mockResolvedValueOnce({ state: BoxState.UNKNOWN })
      adapter.createBox.mockImplementationOnce(async () => {
        jest.advanceTimersByTime(10_001)
      })
      await manager.syncInstanceState(box.id)
      expect(box.state).toBe(BoxState.CREATING)
      expect(events).toEqual([])
      await manager.syncInstanceState(box.id)
      expect(events).toEqual([
        expect.objectContaining({
          'event.outcome': reported === BoxState.STARTED ? 'success' : 'exception',
        }),
      ])
      expect(box).toHaveProperty('startEventPending', false)
      await manager.syncInstanceState(box.id)
      expect(events).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('records the manager catch outcome after persisting ERROR without leaking the runner error', async () => {
    const { manager, box, repository, adapter } = harness()
    adapter.startBox.mockRejectedValue(new Error('private-runner-secret'))
    await manager.syncInstanceState(box.id)
    expect(repository.updateWhere).toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ 'event.outcome': 'exception' })])
    expect(JSON.stringify(events)).not.toContain('private-runner-secret')
  })

  it.each(['0', '2'])('does not mislabel initial creation as a start: version %s', async (version) => {
    const { manager, box } = harness(version, BoxState.CREATING)
    await manager.syncInstanceState(box.id)
    expect(events).toEqual([])
  })

  it.each([false, true])('leaves v2 terminal outcomes to its job handler: failure=%s', async (failure) => {
    const { manager, box, adapter } = harness('2', BoxState.STARTING)
    Object.assign(box, { startEventPending: true })
    if (failure) adapter.boxInfo.mockRejectedValue(new Error('runner-failure'))
    await manager.syncInstanceState(box.id)
    expect(events).toEqual([])
    expect(box).toHaveProperty('startEventPending', false)
  })

  it.each([BoxConflictError, JobConflictError])(
    'does not turn a skipped conflict into a failed start: %p',
    async (ErrorType) => {
      const { manager, box, adapter, repository } = harness()
      Object.assign(box, { startEventPending: true })
      adapter.startBox.mockRejectedValue(new ErrorType())
      await manager.syncInstanceState(box.id)
      expect(repository.updateWhere).not.toHaveBeenCalled()
      expect(events).toEqual([])
      expect(box).toHaveProperty('startEventPending', true)
    },
  )

  it('does not emit an outcome if persisting the error state fails', async () => {
    const { manager, box, adapter, repository } = harness()
    adapter.startBox.mockRejectedValue(new Error('start failed'))
    repository.updateWhere.mockRejectedValue(new Error('database unavailable'))
    await expect(manager.syncInstanceState(box.id)).rejects.toThrow('database unavailable')
    expect(events).toEqual([])
  })

  it('keeps a persisted successful start when outcome attribution fails', async () => {
    const { manager, box, writes, runners } = harness()
    runners.getRunnerApiVersion.mockResolvedValueOnce('0').mockRejectedValueOnce(new Error('lookup failed'))
    await manager.syncInstanceState(box.id)
    expect(box.state).toBe(BoxState.STARTED)
    expect(writes).not.toContain(BoxState.ERROR)
    expect(events).toEqual([])
  })
})
