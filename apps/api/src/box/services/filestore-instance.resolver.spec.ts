import { BadRequestError } from '../../exceptions/bad-request.exception'
import { ServiceUnavailableException } from '@nestjs/common'
import { FilestoreInstanceResolver, type FilestoreInstanceLookup } from './filestore-instance.resolver'

describe('FilestoreInstanceResolver', () => {
  const config = {
    instances: [{ instance: 'ml-scratch', projectId: 'boxlite-dev', zone: 'asia-southeast1-b' }],
  }

  function createResolver(getInstance: jest.Mock, configValue: unknown = config) {
    const configService = { getOrThrow: jest.fn().mockReturnValue(configValue) }
    const clientFactory = jest.fn(() => ({ getInstance }) as FilestoreInstanceLookup)
    const resolver = new FilestoreInstanceResolver(configService as never, clientFactory)
    return { resolver, clientFactory }
  }

  const readyInstance = {
    state: 'READY',
    networks: [{ ipAddresses: ['10.0.0.7'] }],
    fileShares: [{ name: 'vol1' }],
  }

  it('rejects a name outside the deployment list', async () => {
    const { resolver } = createResolver(jest.fn())

    await expect(resolver.resolve('other', 'request')).rejects.toThrow("unknown Filestore instance 'other'")
  })

  it('maps the instance response to the NFS mount target', async () => {
    const getInstance = jest.fn().mockResolvedValue([readyInstance])
    const { resolver } = createResolver(getInstance)

    await expect(resolver.resolve('ml-scratch', 'request')).resolves.toEqual({ server: '10.0.0.7', export: '/vol1' })
    expect(getInstance).toHaveBeenCalledWith({
      name: 'projects/boxlite-dev/locations/asia-southeast1-b/instances/ml-scratch',
    })
  })

  it('caches one successful lookup', async () => {
    const getInstance = jest.fn().mockResolvedValue([readyInstance])
    const { resolver } = createResolver(getInstance)

    await resolver.resolve('ml-scratch', 'request')
    await resolver.resolve('ml-scratch', 'request')

    expect(getInstance).toHaveBeenCalledTimes(1)
  })

  it('maps an explicit missing instance to 400 and a configured one to 503', async () => {
    const notFound = Object.assign(new Error('NOT_FOUND'), { code: 5 })

    await expect(
      createResolver(jest.fn().mockRejectedValue(notFound)).resolver.resolve('ml-scratch', 'request'),
    ).rejects.toBeInstanceOf(BadRequestError)
    await expect(
      createResolver(jest.fn().mockRejectedValue(notFound)).resolver.resolve('ml-scratch', 'configured'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('rejects an ambiguous or not-ready instance', async () => {
    const ambiguous = {
      state: 'READY',
      networks: [{ ipAddresses: ['10.0.0.7', '10.0.0.8'] }],
      fileShares: [{ name: 'vol1' }],
    }
    const notReady = { ...readyInstance, state: 'CREATING' }
    const noShare = { state: 'READY', networks: [{ ipAddresses: ['10.0.0.7'] }], fileShares: [] }

    await expect(
      createResolver(jest.fn().mockResolvedValue([ambiguous])).resolver.resolve('ml-scratch', 'request'),
    ).rejects.toThrow('exactly one IPv4 address')
    await expect(
      createResolver(jest.fn().mockResolvedValue([notReady])).resolver.resolve('ml-scratch', 'request'),
    ).rejects.toThrow('is not ready')
    await expect(
      createResolver(jest.fn().mockResolvedValue([noShare])).resolver.resolve('ml-scratch', 'request'),
    ).rejects.toThrow('one file share')
  })
})
