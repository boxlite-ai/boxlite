import { NotFoundException } from '@nestjs/common'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeService } from './volume.service'

describe('VolumeService delete', () => {
  function createService(volume: { id: string; state: VolumeState } | null) {
    const volumeRepository = {
      findOne: jest.fn().mockResolvedValue(volume),
    }
    const service = new VolumeService(volumeRepository as never, {} as never, {} as never, {} as never, {} as never)

    return { service, volumeRepository }
  }

  it('rejects a missing volume without force', async () => {
    const { service } = createService(null)

    await expect(service.delete('volume-1')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('treats a missing volume as deleted with force', async () => {
    const { service } = createService(null)

    await expect(service.delete('volume-1', true)).resolves.toBeUndefined()
  })

  it.each([VolumeState.PENDING_DELETE, VolumeState.DELETING, VolumeState.DELETED])(
    'treats a volume in %s as deleted with force',
    async (state) => {
      const { service } = createService({ id: 'volume-1', state })

      await expect(service.delete('volume-1', true)).resolves.toBeUndefined()
    },
  )

  it('does not ignore a deleted volume without force', async () => {
    const { service } = createService({ id: 'volume-1', state: VolumeState.DELETED })

    await expect(service.delete('volume-1')).rejects.toThrow("Volume must be in 'ready' or 'error' state")
  })
})
