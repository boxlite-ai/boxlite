import { NotFoundException, RequestTimeoutException } from '@nestjs/common'
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

describe('VolumeService waitForReady', () => {
  function createService(...volumes: Array<Record<string, unknown> | null>) {
    const volumeRepository = {
      findOne: jest.fn().mockImplementation(() => Promise.resolve(volumes.shift() ?? null)),
    }
    const service = new VolumeService(volumeRepository as never, {} as never, {} as never, {} as never, {} as never)
    return { service, volumeRepository }
  }

  it('returns the volume once it is ready', async () => {
    const ready = { id: 'volume-1', state: VolumeState.READY }
    const { service } = createService(ready)

    await expect(service.waitForReady('volume-1', 1)).resolves.toBe(ready)
  })

  it('reports the backend error', async () => {
    const { service } = createService({
      id: 'volume-1',
      state: VolumeState.ERROR,
      errorReason: 'bucket creation failed',
    })

    await expect(service.waitForReady('volume-1', 1)).rejects.toThrow('Volume creation failed')
  })

  it('times out while the volume is still being created', async () => {
    const { service } = createService({ id: 'volume-1', state: VolumeState.PENDING_CREATE })

    await expect(service.waitForReady('volume-1', 0)).rejects.toBeInstanceOf(RequestTimeoutException)
  })
})

describe('VolumeService validateVolumes canonicalization', () => {
  function createService(volumes: Array<Record<string, unknown>>) {
    const volumeRepository = {
      find: jest.fn().mockResolvedValue(volumes),
    }
    const service = new VolumeService(volumeRepository as never, {} as never, {} as never, {} as never, {} as never)
    return { service, volumeRepository }
  }

  it('resolves a name to the id of the volume that carries it', async () => {
    const { service } = createService([{ id: 'uuid-mine', name: 'my-data', state: VolumeState.READY }])

    const canonical = await service.validateVolumes('org-1', ['my-data'])

    expect(canonical.get('my-data')).toBe('uuid-mine')
  })

  // The tenant-boundary case: a caller may name their own volume after another
  // tenant's id. Validation passes because they do own a volume by that name,
  // so the selector must resolve to THEIR volume's id - never be passed through
  // as-is, which is the other tenant's id and the other tenant's bucket.
  it('never passes through a name that impersonates another id', async () => {
    const otherTenantId = 'uuid-belonging-to-someone-else'
    const { service } = createService([{ id: 'uuid-mine', name: otherTenantId, state: VolumeState.READY }])

    const canonical = await service.validateVolumes('org-1', [otherTenantId])

    expect(canonical.get(otherTenantId)).toBe('uuid-mine')
    expect(canonical.get(otherTenantId)).not.toBe(otherTenantId)
  })

  // When one volume's id equals another's name, the id must win: an id is
  // globally unique, a name only unique per organization.
  it('prefers an id match over a name match', async () => {
    const { service } = createService([
      { id: 'collide', name: 'by-id', state: VolumeState.READY },
      { id: 'uuid-other', name: 'collide', state: VolumeState.READY },
    ])

    const canonical = await service.validateVolumes('org-1', ['collide'])

    expect(canonical.get('collide')).toBe('collide')
  })

  it('returns an empty map for no selectors', async () => {
    const { service, volumeRepository } = createService([])

    await expect(service.validateVolumes('org-1', [])).resolves.toEqual(new Map())
    expect(volumeRepository.find).not.toHaveBeenCalled()
  })
})

describe('VolumeService validateVolumes query safety', () => {
  const READY = { state: VolumeState.READY }

  function createService(volumes: Array<Record<string, unknown>>) {
    const volumeRepository = { find: jest.fn().mockResolvedValue(volumes) }
    const service = new VolumeService(volumeRepository as never, {} as never, {} as never, {} as never, {} as never)
    return { service, volumeRepository }
  }

  function whereOf(volumeRepository: { find: jest.Mock }) {
    return volumeRepository.find.mock.calls[0][0].where as Array<Record<string, unknown>>
  }

  // `id` is a Postgres uuid column: comparing it to 'my-data' raises
  // `invalid input syntax for type uuid` and kills the whole query, name
  // branch included. A plain name must never reach that predicate.
  it('keeps a non-uuid selector out of the id predicate', async () => {
    const { service, volumeRepository } = createService([{ id: 'uuid-1', name: 'my-data', ...READY }])

    await service.validateVolumes('org-1', ['my-data'])

    const where = whereOf(volumeRepository)
    expect(where.some((clause) => 'id' in clause)).toBe(false)
    expect(where.some((clause) => 'name' in clause)).toBe(true)
  })

  it('uses the id predicate for a uuid-shaped selector', async () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const { service, volumeRepository } = createService([{ id, name: 'my-data', ...READY }])

    await service.validateVolumes('org-1', [id])

    expect(whereOf(volumeRepository).some((clause) => 'id' in clause)).toBe(true)
  })

  // A stray non-ready volume whose name collides with a ready volume's id is
  // not part of this request; judging it would fail a mount that is fine.
  it('checks readiness only on the volumes actually selected', async () => {
    const { service } = createService([
      { id: 'wanted', name: 'by-id', ...READY },
      { id: 'uuid-other', name: 'wanted', state: VolumeState.PENDING_CREATE },
    ])

    await expect(service.validateVolumes('org-1', ['wanted'])).resolves.toEqual(new Map([['wanted', 'wanted']]))
  })

  it('still rejects a selected volume that is not ready', async () => {
    const { service } = createService([{ id: 'uuid-1', name: 'my-data', state: VolumeState.PENDING_CREATE }])

    await expect(service.validateVolumes('org-1', ['my-data'])).rejects.toThrow('not in a ready state')
  })

  it('rejects a selector that matches nothing', async () => {
    const { service } = createService([])

    await expect(service.validateVolumes('org-1', ['missing'])).rejects.toThrow("Volume 'missing' not found")
  })
})
