import { BoxStartAction } from './box-start.action'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { BoxDesiredState } from '../../enums/box-desired-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { LockCode } from '../../common/redis-lock.provider'

describe('Cloud cold-start nesting', () => {
  function fixture(saved: boolean, allowlisted: boolean, supported: unknown) {
    const box = Object.assign(new Box('region', 'saved'), {
      id: 'box',
      organizationId: 'org',
      runnerId: 'runner',
      nestedVirtualization: saved,
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const lock = new LockCode('lock')
    const startBox = jest.fn().mockResolvedValue(undefined)
    const runnerInfo = jest
      .fn()
      .mockResolvedValue({ nestedVirtualizationEnabled: true, nestedVirtualizationStartEnabled: supported })
    const update = jest.fn(async (_id, { updateData }) => Object.assign(box, updateData))
    const policy = jest.fn().mockResolvedValue(allowlisted)
    const getCode = jest.fn().mockResolvedValue(lock)
    const action = new BoxStartAction(
      { findOneOrFail: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }) } as any,
      { create: jest.fn().mockResolvedValue({ startBox, runnerInfo }) } as any,
      { update } as any,
      { findOne: jest.fn().mockResolvedValue({ boxMetadata: {} }), isNestedVirtualizationEnabled: policy } as any,
      { getOrThrow: () => 0.01 } as any,
      { getCode } as any,
      {} as any,
      {} as any,
    )
    return { action, box, lock, startBox, runnerInfo, update, policy, getCode }
  }

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('starts saved=%s allowlisted=%s using sticky policy', async (saved, allowlisted) => {
    const f = fixture(saved, allowlisted, true)
    await f.action.run(f.box, f.lock)
    expect(f.startBox).toHaveBeenCalledWith('box', f.box.authToken, {}, saved || allowlisted)
    expect(f.box.nestedVirtualization).toBe(saved || allowlisted)
    expect(f.policy).toHaveBeenCalledWith('org')
    if (!saved && allowlisted) {
      expect(f.update).toHaveBeenCalledWith(
        'box',
        expect.objectContaining({ updateData: { nestedVirtualization: true } }),
      )
      expect(f.update.mock.invocationCallOrder[0]).toBeLessThan(f.startBox.mock.invocationCallOrder[0])
    }
  })

  it.each([undefined, false, 'true'])('does not persist or dispatch an unconfirmed upgrade (%p)', async (supported) => {
    const f = fixture(false, true, supported)
    await expect(f.action.run(f.box, f.lock)).rejects.toThrow(/nested virtualization/i)
    expect(f.startBox).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.box.nestedVirtualization).toBe(false)
  })

  it('retains saved true after dispatch failure and allowlist removal', async () => {
    const f = fixture(false, true, true)
    f.startBox.mockRejectedValueOnce(new Error('dispatch failed'))
    await expect(f.action.run(f.box, f.lock)).rejects.toThrow('dispatch failed')
    f.policy.mockResolvedValue(false)
    await f.action.run(f.box, f.lock)
    expect(f.startBox).toHaveBeenLastCalledWith('box', f.box.authToken, {}, true)
    expect(f.box.nestedVirtualization).toBe(true)
  })

  it('bounds a stalled capability lookup before saving or dispatching', async () => {
    const f = fixture(false, true, true)
    f.runnerInfo.mockImplementation(() => new Promise(() => {}))
    await expect(f.action.run(f.box, f.lock)).rejects.toThrow()
    expect(f.update).not.toHaveBeenCalled()
    expect(f.startBox).not.toHaveBeenCalled()
  })

  it('does not save or dispatch after losing its lifecycle lock', async () => {
    const f = fixture(false, true, true)
    f.getCode.mockResolvedValue(null)
    await f.action.run(f.box, f.lock)
    expect(f.update).not.toHaveBeenCalled()
    expect(f.startBox).not.toHaveBeenCalled()
  })
})
