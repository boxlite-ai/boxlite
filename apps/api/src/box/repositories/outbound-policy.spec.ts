import { BoxRepository } from './box.repository'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

function fixture() {
  const box = {
    id: 'box1',
    organizationId: 'org1',
    runnerId: 'runner1',
    state: BoxState.STARTED,
    desiredState: BoxDesiredState.STARTED,
    outboundEnabled: true,
    outboundAllowNet: ['old.example'],
  }
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(box),
    update: jest.fn().mockResolvedValue(undefined),
  }
  const transaction = jest.fn(async (fn) => fn(manager))
  const cache = { invalidate: jest.fn() }
  const repository = new BoxRepository(
    {
      getRepository: () => ({ manager: { transaction } }),
    } as any,
    {} as any,
    cache as any,
  )
  return { repository, manager, box }
}

describe('outbound policy persistence', () => {
  it('applies before persistence and clears an old list', async () => {
    const { repository, manager } = fixture()
    const apply = jest.fn().mockResolvedValue(undefined)
    const result = await repository.replaceOutbound('box1', 'org1', { mode: 'enabled', allow_net: [] }, apply)
    expect(manager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        where: { id: 'box1', organizationId: 'org1' },
        lock: { mode: 'pessimistic_write' },
      }),
    )
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(manager.update.mock.invocationCallOrder[0])
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), 'box1', {
      outboundEnabled: true,
      outboundAllowNet: null,
    })
    expect(result.outboundAllowNet).toBeNull()
  })

  it('does not persist when runtime application fails', async () => {
    const { repository, manager } = fixture()
    const apply = jest.fn().mockRejectedValue(new Error('runner refused'))
    await expect(
      repository.replaceOutbound('box1', 'org1', { mode: 'disabled', allow_net: [] }, apply),
    ).rejects.toThrow('runner refused')
    expect(manager.update).not.toHaveBeenCalled()
  })

  it('restores the previous policy when persistence fails', async () => {
    const { repository, manager } = fixture()
    manager.update.mockRejectedValue(new Error('database failed'))
    const apply = jest.fn().mockResolvedValue(undefined)
    await expect(
      repository.replaceOutbound('box1', 'org1', { mode: 'disabled', allow_net: [] }, apply),
    ).rejects.toThrow('database failed')
    expect(apply).toHaveBeenLastCalledWith(expect.anything(), { mode: 'enabled', allow_net: ['old.example'] })
  })

  it('persists a non-empty list and restores a default previous policy', async () => {
    const { repository, manager, box } = fixture()
    box.outboundEnabled = false
    box.outboundAllowNet = null as any
    manager.update.mockRejectedValueOnce(new Error('database failed'))
    const apply = jest.fn().mockResolvedValue(undefined)
    const policy = { mode: 'enabled' as const, allow_net: ['*.example.com'] }
    await expect(repository.replaceOutbound('box1', 'org1', policy, apply)).rejects.toThrow('database failed')
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), 'box1', {
      outboundEnabled: true,
      outboundAllowNet: ['*.example.com'],
    })
    expect(apply).toHaveBeenLastCalledWith(expect.anything(), { mode: 'disabled', allow_net: [] })
  })

  it('reports an uncertain live policy when rollback also fails', async () => {
    const { repository, manager } = fixture()
    manager.update.mockRejectedValue(new Error('database failed'))
    const apply = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('runner gone'))
    await expect(repository.replaceOutbound('box1', 'org1', { mode: 'enabled', allow_net: [] }, apply)).rejects.toThrow(
      'live policy is uncertain',
    )
  })

  it('reports a missing box', async () => {
    const { repository, manager } = fixture()
    manager.findOne.mockResolvedValue(null)
    await expect(
      repository.replaceOutbound('box1', 'org1', { mode: 'enabled', allow_net: [] }, jest.fn()),
    ).rejects.toThrow('Box not found')
  })

  it.each([
    ['stopping', { desiredState: BoxDesiredState.STOPPED }],
    ['unassigned', { runnerId: null }],
  ])('refuses a %s box before contacting the runner', async (_name, patch) => {
    const { repository, box } = fixture()
    Object.assign(box, patch)
    const apply = jest.fn()
    await expect(repository.replaceOutbound('box1', 'org1', { mode: 'enabled', allow_net: [] }, apply)).rejects.toThrow(
      'running box',
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it('refuses a stopped box before contacting the runner', async () => {
    const { repository, box } = fixture()
    box.state = BoxState.STOPPED
    const apply = jest.fn()
    await expect(repository.replaceOutbound('box1', 'org1', { mode: 'enabled', allow_net: [] }, apply)).rejects.toThrow(
      'running box',
    )
    expect(apply).not.toHaveBeenCalled()
  })
})
