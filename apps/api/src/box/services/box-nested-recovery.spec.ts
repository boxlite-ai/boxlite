import { Context } from '../../common/context/context'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'

describe('Saved nested box recovery', () => {
  function fixture(capability: unknown, nestedVirtualization = true, apiVersion = '0') {
    const box = { id: 'saved-box', runnerId: 'runner-1', state: BoxState.ERROR, nestedVirtualization }
    const organization = { id: 'org-1', nestedVirtualizationEnabled: false }
    const runnerInfo = jest.fn().mockResolvedValue({ nestedVirtualizationEnabled: capability })
    const recoverBox = jest.fn().mockResolvedValue(undefined)
    const updateWhere = jest.fn().mockResolvedValue(box)
    const start = jest.fn().mockResolvedValue(box)
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      findOneByIdOrName: jest.fn().mockResolvedValue(box),
      runnerService: { findOneOrFail: jest.fn().mockResolvedValue({ id: 'runner-1', apiVersion }) },
      runnerAdapterFactory: { create: jest.fn().mockResolvedValue({ runnerInfo, recoverBox }) },
      boxRepository: { updateWhere },
      configService: { getOrThrow: () => 0.01 },
      logger: { warn: jest.fn() },
      start,
    })
    return { service, box, organization, runnerInfo, recoverBox, updateWhere, start }
  }

  it.each([false, undefined, null, 'true', 1])('rejects unconfirmed capability %p before recovery', async (value) => {
    const h = fixture(value)
    await expect(h.service.recover(h.box.id, h.organization as any, Context.user())).rejects.toThrow(
      'Nested boxes require',
    )
    expect(h.recoverBox).not.toHaveBeenCalled()
    expect(h.updateWhere).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it.each(['error', 'timeout'])('rejects %s discovery before recovery', async (mode) => {
    const h = fixture(true)
    if (mode === 'error') h.runnerInfo.mockRejectedValue(new Error('Runner unavailable'))
    else h.runnerInfo.mockImplementation(() => new Promise(() => {}))
    await expect(h.service.recover(h.box.id, h.organization as any, Context.user())).rejects.toThrow(
      'Nested boxes require',
    )
    expect(h.recoverBox).not.toHaveBeenCalled()
    expect(h.updateWhere).not.toHaveBeenCalled()
  })

  it('recovers the saved nested decision after the organization grant is revoked', async () => {
    const h = fixture(true)
    await expect(h.service.recover(h.box.id, h.organization as any, Context.user())).resolves.toBe(h.box)
    expect(h.runnerInfo).toHaveBeenCalledTimes(1)
    expect(h.recoverBox).toHaveBeenCalledWith(h.box)
    expect(h.start).toHaveBeenCalledWith(h.box.id, h.organization, Context.user())
  })

  it('keeps ordinary recovery independent of discovery', async () => {
    const h = fixture(undefined, false)
    await h.service.recover(h.box.id, h.organization as any, Context.user())
    expect(h.runnerInfo).not.toHaveBeenCalled()
    expect(h.recoverBox).toHaveBeenCalledWith(h.box)
  })

  it('rejects nested recovery on V2 before dispatch', async () => {
    const h = fixture(true, true, '2')
    await expect(h.service.recover(h.box.id, h.organization as any, Context.user())).rejects.toThrow(
      'Recovering boxes with runner API version 2 is not supported',
    )
    expect(h.recoverBox).not.toHaveBeenCalled()
  })
})
