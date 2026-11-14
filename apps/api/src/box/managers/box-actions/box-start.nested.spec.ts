import { BoxStartAction } from './box-start.action'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { BoxDesiredState } from '../../enums/box-desired-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { LockCode } from '../../common/redis-lock.provider'

describe('Cloud create-only nesting', () => {
  function fixture(allowlisted: boolean, supported: unknown) {
    const box = Object.assign(new Box('region', 'saved'), {
      id: 'box',
      organizationId: 'org',
      runnerId: 'runner',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const lock = new LockCode('lock')
    const startBox = jest.fn().mockResolvedValue(undefined)
    const createBox = jest.fn().mockResolvedValue(undefined)
    const runnerInfo = jest.fn().mockResolvedValue({ nestedVirtualizationEnabled: supported })
    const update = jest.fn(async (_id, { updateData }) => Object.assign(box, updateData))
    const policy = jest.fn().mockResolvedValue(allowlisted)
    const getCode = jest.fn().mockResolvedValue(lock)
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }) } as any,
      { create: jest.fn().mockResolvedValue({ startBox, createBox, runnerInfo }) } as any,
      { update } as any,
      { findOne: jest.fn().mockResolvedValue({ boxMetadata: {} }), isNestedVirtualizationEnabled: policy } as any,
      { getOrThrow: () => 0.01 } as any,
      { getCode } as any,
      {} as any,
      { refFor: jest.fn().mockResolvedValue('alpine') } as any,
      {} as any,
    )
    return { action, box, lock, startBox, createBox, runnerInfo, update, policy, getCode }
  }

  it.each([true, false, undefined])('selects nesting only at actual create dispatch (%p)', async (supported) => {
    const f = fixture(true, supported)
    f.box.state = BoxState.UNKNOWN
    f.box.image = 'alpine'
    await f.action.run(f.box, f.lock)
    expect(f.createBox).toHaveBeenCalledWith(f.box, 'alpine', {}, supported === true)
    expect(f.box.state).toBe(BoxState.CREATING)
    expect(f.box).not.toHaveProperty('nestedVirtualization')
  })

  it.each([true, false])('keeps start independent of current organization policy %p', async (allowed) => {
    const f = fixture(allowed, true)
    await f.action.run(f.box, f.lock)
    expect(f.startBox).toHaveBeenCalledWith('box', f.box.authToken, {})
    expect(f.policy).not.toHaveBeenCalled()
    expect(f.runnerInfo).not.toHaveBeenCalled()
    expect(f.box.state).toBe(BoxState.STARTING)
  })

  it.each(['error', 'timeout'])('falls back at create after discovery %s', async (mode) => {
    const f = fixture(true, true)
    f.box.state = BoxState.UNKNOWN
    f.box.image = 'alpine'
    if (mode === 'error') f.runnerInfo.mockRejectedValue(new Error('unavailable'))
    else f.runnerInfo.mockImplementation(() => new Promise(() => {}))
    await f.action.run(f.box, f.lock)
    expect(f.createBox).toHaveBeenCalledWith(f.box, 'alpine', {}, false)
  })
})
