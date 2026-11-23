import { VolumeController } from './volume.controller'
import { Context } from '../../common/context/context'
import { VolumeState } from '../enums/volume-state.enum'

describe('VolumeController Activity caller context', () => {
  const ctx = Context.user({ userId: 'user-1', authMethod: 'jwt', clientSource: 'dashboard' })
  const organization = { id: 'org-1' }
  const volume = {
    id: 'volume-1',
    organizationId: organization.id,
    name: 'workspace',
    state: VolumeState.PENDING_CREATE,
    createdAt: new Date('2026-11-02T00:00:00Z'),
  }

  function harness() {
    const service = {
      create: jest.fn().mockResolvedValue(volume),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    return { service, controller: new VolumeController(service as never) }
  }

  it('passes the caller to creation and projects the saved volume', async () => {
    const { controller, service } = harness()
    const input = { name: 'workspace' }
    const result = await controller.createVolume({ organization } as never, input, ctx)

    expect(service.create).toHaveBeenCalledWith(organization, input, ctx)
    expect(result).toMatchObject({
      id: volume.id,
      organizationId: organization.id,
      state: VolumeState.PENDING_CREATE,
      createdAt: '2026-11-02T00:00:00.000Z',
    })
  })

  it('passes the caller to deletion and propagates a refusal', async () => {
    const { controller, service } = harness()
    await expect(controller.deleteVolume(volume.id, ctx)).resolves.toBeUndefined()
    expect(service.delete).toHaveBeenCalledWith(volume.id, ctx)

    const error = new Error('Volume is in use')
    service.delete.mockRejectedValue(error)
    await expect(controller.deleteVolume(volume.id, ctx)).rejects.toBe(error)
  })
})
