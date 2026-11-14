import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import { VolumeDto } from './volume.dto'

function volume(overrides: Partial<Volume> = {}): Volume {
  return {
    id: 'volume-1',
    name: 'my-volume',
    organizationId: 'org-1',
    state: VolumeState.READY,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  } as Volume
}

describe('VolumeDto', () => {
  it('derives an object-storage backend from an absent instance', () => {
    const dto = VolumeDto.fromVolume(volume())

    expect(dto.storageBackend).toBe('object_storage')
    expect(dto.instance).toBeUndefined()
  })

  it('derives a Filestore backend and preserves only the logical instance name', () => {
    const dto = VolumeDto.fromVolume(volume({ instance: 'ml-scratch' }))

    expect(dto.storageBackend).toBe('filestore')
    expect(dto.instance).toBe('ml-scratch')
  })
})
