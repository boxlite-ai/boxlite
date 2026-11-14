import { Context } from '../../common/context/context'
import {
  ForbiddenException,
  NotFoundException,
  NotImplementedException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { VolumeState } from '../enums/volume-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { VolumeService } from './volume.service'

describe('VolumeService delete', () => {
  function createService(volume: { id: string; state: VolumeState } | null) {
    const volumeRepository = {
      findOne: jest.fn().mockResolvedValue(volume),
    }
    const service = new VolumeService(
      volumeRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    return { service, volumeRepository }
  }

  it('rejects a missing volume without force', async () => {
    const { service } = createService(null)

    await expect(service.delete('volume-1', Context.user())).rejects.toBeInstanceOf(NotFoundException)
  })

  it('treats a missing volume as deleted with force', async () => {
    const { service } = createService(null)

    await expect(service.delete('volume-1', Context.user(), true)).resolves.toBeUndefined()
  })

  it.each([VolumeState.PENDING_DELETE, VolumeState.DELETING, VolumeState.DELETED])(
    'treats a volume in %s as deleted with force',
    async (state) => {
      const { service } = createService({ id: 'volume-1', state })

      await expect(service.delete('volume-1', Context.user(), true)).resolves.toBeUndefined()
    },
  )

  it('does not ignore a deleted volume without force', async () => {
    const { service } = createService({ id: 'volume-1', state: VolumeState.DELETED })

    await expect(service.delete('volume-1', Context.user())).rejects.toThrow(
      "Volume must be in 'ready' or 'error' state",
    )
  })
})

describe('VolumeService waitForReady', () => {
  function createService(...volumes: Array<Record<string, unknown> | null>) {
    const volumeRepository = {
      findOne: jest.fn().mockImplementation(() => Promise.resolve(volumes.shift() ?? null)),
    }
    const service = new VolumeService(
      volumeRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
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
    const service = new VolumeService(
      volumeRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return { service, volumeRepository }
  }

  it('resolves a name to the id of the volume that carries it', async () => {
    const { service } = createService([{ id: 'uuid-mine', name: 'my-data', state: VolumeState.READY }])

    const canonical = await service.validateVolumes('org-1', ['my-data'])

    expect(canonical.get('my-data')?.id).toBe('uuid-mine')
  })

  // The tenant-boundary case: a caller may name their own volume after another
  // tenant's id. Validation passes because they do own a volume by that name,
  // so the selector must resolve to THEIR volume's id - never be passed through
  // as-is, which is the other tenant's id and the other tenant's bucket.
  it('never passes through a name that impersonates another id', async () => {
    const otherTenantId = 'uuid-belonging-to-someone-else'
    const { service } = createService([{ id: 'uuid-mine', name: otherTenantId, state: VolumeState.READY }])

    const canonical = await service.validateVolumes('org-1', [otherTenantId])

    expect(canonical.get(otherTenantId)?.id).toBe('uuid-mine')
    expect(canonical.get(otherTenantId)?.id).not.toBe(otherTenantId)
  })

  // When one volume's id equals another's name, the id must win: an id is
  // globally unique, a name only unique per organization.
  it('prefers an id match over a name match', async () => {
    const { service } = createService([
      { id: 'collide', name: 'by-id', state: VolumeState.READY },
      { id: 'uuid-other', name: 'collide', state: VolumeState.READY },
    ])

    const canonical = await service.validateVolumes('org-1', ['collide'])

    expect(canonical.get('collide')?.id).toBe('collide')
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
    const service = new VolumeService(
      volumeRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
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

    await expect(service.validateVolumes('org-1', ['wanted'])).resolves.toEqual(
      new Map([['wanted', { id: 'wanted', name: 'by-id', state: VolumeState.READY }]]),
    )
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

// Filestore volumes are Volume rows with an `instance`; their lifecycle
// differs from the bucket kind in exactly two places: nothing to provision
// API-side (the runner creates the data directory lazily at first mount, so
// the volume is READY at once) and nothing to tear down (the NFS directory is
// left in place for ops cleanup, so delete tombstones the row directly — the
// volume manager cron runs even when only filestore volumes exist, because
// deletion is row-only for them).
describe('VolumeService filestore volumes', () => {
  function createService(
    volume: Record<string, unknown> | null,
    boxes: Array<Record<string, unknown>> = [],
    filestoreInstances: Array<{ instance: string; projectId: string; zone: string }> = [
      { instance: 'ml-scratch', projectId: 'boxlite-dev', zone: 'asia-southeast1-b' },
    ],
    filestoreSupported = true,
  ) {
    const volumeRepository = {
      findOne: jest.fn().mockResolvedValue(volume),
      save: jest.fn().mockImplementation(async (v) => v),
    }
    const boxRepository = {
      createQueryBuilder: jest.fn(() => {
        const builder = {
          where: () => builder,
          andWhere: () => builder,
          select: () => builder,
          getOne: jest.fn().mockResolvedValue(boxes[0] ?? null),
        }
        return builder
      }),
    }
    const organizationService = { assertOrganizationIsNotSuspended: jest.fn() }
    const configService = {
      get: jest.fn((key: string) => {
        expect(key).toBe('volume.filestoreSupported')
        return filestoreSupported
      }),
      getOrThrow: jest.fn((key: string) => {
        expect(key).toBe('volume.filestoreInstances')
        return { instances: filestoreInstances }
      }),
    }
    const filestoreInstanceResolver = {
      resolve: jest.fn().mockResolvedValue({ server: '10.0.0.7', export: '/vol1' }),
      select: jest.fn().mockImplementation(() => {
        if (!filestoreInstances.length) throw new ServiceUnavailableException('Filestore is not configured')
        return filestoreInstances[0]
      }),
    }
    const service = new VolumeService(
      volumeRepository as never,
      boxRepository as never,
      organizationService as never,
      configService as never,
      {} as never,
      filestoreInstanceResolver as never,
    )
    return { service, volumeRepository, filestoreInstanceResolver, organizationService }
  }

  const organization = { id: 'org-1' } as never

  it('creates a filestore volume READY, without consulting object storage', async () => {
    const { service } = createService(null)

    const volume = await service.create(
      organization,
      { name: 'nfs-data', storageBackend: 'filestore', instance: 'ml-scratch' },
      Context.user(),
    )

    expect(volume.state).toBe(VolumeState.READY)
    expect(volume.instance).toBe('ml-scratch')
  })

  it('rejects a duplicate name before consulting GCP', async () => {
    const { service, filestoreInstanceResolver } = createService({
      id: 'existing',
      name: 'nfs-data',
      state: VolumeState.READY,
      instance: 'ml-scratch',
    })
    filestoreInstanceResolver.resolve.mockRejectedValue(new ServiceUnavailableException('GCP unavailable'))

    await expect(
      service.create(
        organization,
        { name: 'nfs-data', storageBackend: 'filestore', instance: 'ml-scratch' },
        Context.user(),
      ),
    ).rejects.toThrow('already exists')
    expect(filestoreInstanceResolver.resolve).not.toHaveBeenCalled()
  })

  it('rejects a suspended organization before consulting GCP', async () => {
    const { service, filestoreInstanceResolver, organizationService } = createService(null)
    organizationService.assertOrganizationIsNotSuspended.mockImplementation(() => {
      throw new ForbiddenException('Organization is suspended')
    })
    filestoreInstanceResolver.resolve.mockRejectedValue(new ServiceUnavailableException('GCP unavailable'))

    await expect(
      service.create(
        organization,
        { name: 'nfs-data', storageBackend: 'filestore', instance: 'ml-scratch' },
        Context.user(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(filestoreInstanceResolver.resolve).not.toHaveBeenCalled()
  })

  it('assigns an omitted Filestore instance from the configured objects', async () => {
    const { service, filestoreInstanceResolver } = createService(
      null,
      [],
      [
        { instance: 'zeta', projectId: 'zeta-project', zone: 'us-east5-a' },
        { instance: 'alpha', projectId: 'alpha-project', zone: 'us-east5-b' },
      ],
    )

    const volume = await service.create(organization, { name: 'nfs-data', storageBackend: 'filestore' }, Context.user())

    const [selected, source] = filestoreInstanceResolver.resolve.mock.calls[0]
    expect(volume.instance).toBe(selected)
    expect(['alpha', 'zeta']).toContain(selected)
    expect(source).toBe('configured')
  })

  it('rejects Filestore placement when no instances are configured', async () => {
    const { service, volumeRepository } = createService(null, [], [])

    await expect(service.create(organization, { storageBackend: 'filestore' }, Context.user())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
    expect(volumeRepository.save).not.toHaveBeenCalled()
  })

  it('rejects Filestore creation on an unsupported deployment without persisting a row', async () => {
    const { service, volumeRepository, filestoreInstanceResolver } = createService(null, [], [
      { instance: 'ml-scratch', projectId: 'boxlite-dev', zone: 'asia-southeast1-b' },
    ], false)

    await expect(
      service.create(organization, { name: 'nfs-data', storageBackend: 'filestore' }, Context.user()),
    ).rejects.toMatchObject({
      constructor: NotImplementedException,
      response: { code: 'unsupported', message: expect.stringContaining('not supported') },
    })
    expect(volumeRepository.save).not.toHaveBeenCalled()
    expect(filestoreInstanceResolver.resolve).not.toHaveBeenCalled()
  })

  it('rejects an explicit instance the resolver cannot find, without persisting a row', async () => {
    const { service, volumeRepository, filestoreInstanceResolver } = createService(null)
    filestoreInstanceResolver.resolve.mockRejectedValue(new BadRequestError('Filestore instance ... not found'))

    await expect(
      service.create(
        organization,
        { name: 'nfs-data', storageBackend: 'filestore', instance: 'ml-scratch' },
        Context.user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(volumeRepository.save).not.toHaveBeenCalled()
  })

  it('rejects a hash-assigned instance whose lookup fails, without persisting a row', async () => {
    const { service, volumeRepository, filestoreInstanceResolver } = createService(null)
    filestoreInstanceResolver.resolve.mockRejectedValue(
      new ServiceUnavailableException('Filestore instance ... not found'),
    )

    await expect(
      service.create(organization, { name: 'nfs-data', storageBackend: 'filestore' }, Context.user()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(volumeRepository.save).not.toHaveBeenCalled()
  })

  it('rejects instance placement without the explicit Filestore backend', async () => {
    const { service, volumeRepository } = createService(null)

    await expect(service.create(organization, { instance: 'ml-scratch' }, Context.user())).rejects.toThrow(
      'instance is valid only when storageBackend is "filestore"',
    )
    expect(volumeRepository.save).not.toHaveBeenCalled()
  })

  it('sends a filestore volume through the same async delete path as buckets', async () => {
    const { service, volumeRepository } = createService({
      id: 'volume-1',
      name: 'nfs-data',
      state: VolumeState.READY,
      instance: 'ml-scratch',
    })

    await service.delete('volume-1', Context.user())

    expect(volumeRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'volume-1', state: VolumeState.PENDING_DELETE }),
    )
  })

  it('still refuses to delete a filestore volume a live box references', async () => {
    const { service } = createService(
      { id: 'volume-1', name: 'nfs-data', state: VolumeState.READY, instance: 'ml-scratch' },
      [{ id: 'box-1', name: 'my-box' }],
    )

    await expect(service.delete('volume-1', Context.user())).rejects.toThrow('in use by one or more boxes')
  })
})
