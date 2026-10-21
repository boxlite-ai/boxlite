import { HttpException, NotFoundException } from '@nestjs/common'
import { SnapshotService } from './snapshot.service'

const id = '57a5d67c-207d-485e-84af-e4c49d31248d'
const auth = { organizationId: 'tenant-a', organization: { id: 'tenant-a' } } as any

describe('SnapshotService ownership and placement', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  function fixture() {
    const catalog = { findOneBy: jest.fn(), save: jest.fn(), create: jest.fn((v) => v) }
    const boxes = {
      findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'source', runnerId: 'owner' }),
      create: jest.fn(),
    }
    const runners = {
      findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.test', apiKey: 'local-test' }),
      getRandomAvailableRunner: jest
        .fn()
        .mockResolvedValue({ id: 'destination', apiUrl: 'http://target.test', apiKey: 'target-test' }),
    }
    const waiter = { waitForStarted: jest.fn() }
    const limits = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
    const service = new SnapshotService(catalog as any, boxes as any, runners as any, waiter as any, limits as any)
    return { service, catalog, boxes, runners }
  }

  it('looks up snapshots in the authenticated tenant before contacting a runner', async () => {
    const { service, catalog, runners } = fixture()
    catalog.findOneBy.mockResolvedValue(null)
    await expect(service.get(auth, id)).rejects.toBeInstanceOf(NotFoundException)
    expect(catalog.findOneBy).toHaveBeenCalledWith({ id, organizationId: 'tenant-a' })
    expect(runners.findOne).not.toHaveBeenCalled()
  })

  it('does not publish catalog metadata for rejected memory capture', async () => {
    const { service, catalog } = fixture()
    global.fetch = jest
      .fn()
      .mockResolvedValue({ status: 501, ok: false, json: async () => ({ error: { code: 'unsupported' } }) })
    await expect(service.capture(auth, 'source', { name: 'ram', snapshot_type: 'memory' })).rejects.toBeInstanceOf(
      HttpException,
    )
    expect(catalog.save).not.toHaveBeenCalled()
  })

  it('preserves runner error codes in the flat Nest exception contract', async () => {
    const { service } = fixture()
    global.fetch = jest.fn().mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({ error: { code: 'already_exists', message: 'duplicate snapshot' } }),
    })
    try {
      await service.capture(auth, 'source', { name: 'duplicate' })
      throw new Error('capture unexpectedly succeeded')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException)
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'already_exists', message: 'duplicate snapshot' }),
      )
    }
  })

  it('preserves owner placement and excludes source mounts in child admission', async () => {
    const { service, catalog, boxes } = fixture()
    catalog.findOneBy.mockResolvedValue({
      id,
      runnerId: 'owner',
      nativeId: 'native',
      createOptions: { image: 'alpine:3.23', target: 'local' },
    })
    global.fetch = jest
      .fn()
      .mockResolvedValue({ status: 200, ok: true, json: async () => ({ snapshot_type: 'filesystem', is_mock: false }) })
    const refusal = new Error('owner unavailable')
    boxes.create.mockRejectedValue(refusal)
    await expect(service.createBox(auth, id, 'child')).rejects.toBe(refusal)
    expect(boxes.create).toHaveBeenCalledWith(
      { image: 'alpine:3.23', target: 'local', name: 'child' },
      auth.organization,
      expect.anything(),
      { maxCreatedBoxes: 3, snapshot: { nativeId: 'native', runnerId: 'owner' } },
    )
    expect(boxes.create.mock.calls[0][0]).not.toHaveProperty('volumes')
  })

  function copyFixture() {
    const f = fixture()
    f.catalog.findOneBy.mockResolvedValue({
      id,
      runnerId: 'owner',
      nativeId: 'native-source',
      sourceBoxId: 'source',
      metadata: { snapshot_type: 'filesystem', is_mock: false },
      createOptions: { image: 'alpine:3.23', target: 'local', entrypoint: ['sh'] },
    })
    global.fetch = jest.fn(async (url, options: any) => {
      if (String(url).endsWith('/archive'))
        return new Response('archive-bytes', { headers: { 'X-Boxlite-Architecture': 'arm64' } })
      if (options.method === 'DELETE') return new Response(null, { status: 204 })
      expect(await new Response(options.body).text()).toBe('archive-bytes')
      return Response.json({ id: 'native-copy', snapshot_type: 'filesystem', is_mock: false })
    }) as any
    return f
  }

  it('streams migration archives to an eligible destination and publishes a separate owner', async () => {
    const { service, catalog, runners } = copyFixture()
    const copied = await service.copy(auth, id, 'destination', 'independent')
    expect(copied.id).not.toBe(id)
    expect(copied.box_id).toBe('source')
    expect(runners.getRandomAvailableRunner).toHaveBeenCalledWith({
      requiredRunnerId: 'destination',
      regions: ['local'],
      boxClass: undefined,
    })
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://target.test/v1/snapshot-imports/independent',
      expect.objectContaining({
        duplex: 'half',
        headers: expect.objectContaining({ Authorization: 'Bearer target-test' }),
      }),
    )
    expect(catalog.save).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeId: 'native-copy',
        runnerId: 'destination',
        organizationId: 'tenant-a',
        createOptions: { image: 'alpine:3.23', target: 'local', entrypoint: ['sh'] },
      }),
    )
  })

  it('denies foreign snapshots and unavailable destinations before archive transfer', async () => {
    const { service, catalog, runners } = copyFixture()
    runners.getRandomAvailableRunner.mockRejectedValue(new Error('unavailable'))
    await expect(service.copy(auth, id, 'destination')).rejects.toThrow('unavailable')
    expect(global.fetch).not.toHaveBeenCalled()
    catalog.findOneBy.mockResolvedValue(null)
    await expect(service.copy(auth, id, 'destination')).rejects.toBeInstanceOf(NotFoundException)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('removes only the new native snapshot if catalog publication fails', async () => {
    const { service, catalog } = copyFixture()
    catalog.save.mockRejectedValue(new Error('catalog unavailable'))
    await expect(service.copy(auth, id, 'destination')).rejects.toThrow('catalog unavailable')
    expect(global.fetch).toHaveBeenLastCalledWith(
      'http://runner.test/v1/snapshots/native-copy',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('refuses mock memory copies without asking a runner', async () => {
    const { service, catalog, runners } = copyFixture()
    catalog.findOneBy.mockResolvedValue({ metadata: { snapshot_type: 'memory', is_mock: true } })
    await expect(service.copy(auth, id, 'destination')).rejects.toBeInstanceOf(HttpException)
    expect(runners.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('reports a duplicate name as conflict after removing the unpublished native copy', async () => {
    const { service, catalog } = copyFixture()
    catalog.save.mockRejectedValue({ driverError: { code: '23505' } })
    await expect(service.copy(auth, id, 'destination', 'duplicate')).rejects.toMatchObject({ status: 409 })
    expect(global.fetch).toHaveBeenLastCalledWith(
      'http://runner.test/v1/snapshots/native-copy',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('preserves target version/architecture errors without publishing a snapshot', async () => {
    const { service, catalog } = copyFixture()
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockImplementationOnce(
      async () => new Response('archive', { headers: { 'X-Boxlite-Architecture': 'arm64' } }),
    )
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: { code: 'unsupported', message: 'incompatible archive' } }, { status: 501 }),
    )
    await expect(service.copy(auth, id, 'destination')).rejects.toMatchObject({
      status: 501,
      response: { code: 'unsupported', message: 'incompatible archive' },
    })
    expect(catalog.save).not.toHaveBeenCalled()
  })
})
