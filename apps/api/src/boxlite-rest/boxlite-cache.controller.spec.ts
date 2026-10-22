import { BoxliteCacheController } from './boxlite-cache.controller'
import { CreateBoxDto } from './dto/create-box.dto'
import { createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'

describe('runner cache contract', () => {
  it('maps a cache origin without durable-volume resolution or a placement hint', async () => {
    const dto = plainToInstance(CreateBoxDto, {
      image: 'alpine:3.23',
      volumes: [{ cache_volume: 'build-1', guest_path: '/cache' }],
    })
    expect(await validate(dto)).toHaveLength(0)
    const internal = createBoxToCreateBox(dto)
    expect(internal.volumes).toEqual([{ type: 'cache', volumeId: 'build-1', mountPath: '/cache' }])
    expect(internal.target).toBeUndefined()
  })
  it.each([
    { cache_volume: '../bad', guest_path: '/cache' },
    { cache_volume: 'cache', managed_volume: 'durable', guest_path: '/cache' },
    { cache_volume: 'cache', read_only: true, guest_path: '/cache' },
  ])('rejects invalid cache shape %j', async (volume) => {
    expect(await validate(plainToInstance(CreateBoxDto, { volumes: [volume] }))).not.toHaveLength(0)
  })
  it('uses only the authenticated tenant for the runner request', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ type: 'cache', id: 'build', in_use: false }),
      } as Response)
    try {
      const controller = new BoxliteCacheController(
        {
          findOne: jest.fn().mockResolvedValue({ region: 'region', apiUrl: 'http://runner', apiKey: 'secret' }),
        } as never,
        { findOne: jest.fn().mockResolvedValue({ organizationId: null }) } as never,
      )
      await controller.getCache({ organizationId: 'tenant-a' } as never, 'runner-id', 'build')
      expect(fetcher.mock.calls[0][0]).toBe('http://runner/v1/caches/tenant-a/build')
    } finally {
      fetcher.mockRestore()
    }
  })
  it('refuses a private runner owned by another organization before any I/O', async () => {
    const fetcher = jest.spyOn(global, 'fetch')
    try {
      const controller = new BoxliteCacheController(
        { findOne: jest.fn().mockResolvedValue({ region: 'region', apiUrl: 'http://runner' }) } as never,
        { findOne: jest.fn().mockResolvedValue({ organizationId: 'tenant-b' }) } as never,
      )
      await expect(controller.getCache({ organizationId: 'tenant-a' } as never, 'runner-id', 'build')).rejects.toThrow(
        'unavailable',
      )
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
})
