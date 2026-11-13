import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Logger, ServiceUnavailableException } from '@nestjs/common'
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

  // The real @google-cloud/filestore client decodes the protobuf enum as a
  // number (READY = 2); mocks must match that wire shape, not the key name.
  const readyInstance = {
    state: 2,
    networks: [{ ipAddresses: ['10.0.0.7'] }],
    fileShares: [{ name: 'vol1' }],
  }

  it('sorts instances by name and keeps a stable selection for one volume id', () => {
    const instances = [
      { instance: 'zebra', projectId: 'project', zone: 'us-east5-a' },
      { instance: 'middle', projectId: 'project', zone: 'us-east5-b' },
      { instance: 'apple', projectId: 'project', zone: 'us-east5-c' },
    ]
    const { resolver } = createResolver(jest.fn(), { instances })

    expect(resolver.select('a')).toEqual(instances[0])
    expect(resolver.select('volume-id')).toEqual(resolver.select('volume-id'))
  })

  it('rejects automatic placement without candidates', () => {
    const { resolver } = createResolver(jest.fn(), { instances: [] })

    expect(() => resolver.select('volume-id')).toThrow('Filestore is not configured')
  })

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

  it('maps an explicit missing instance to 400 and a configured one to 503 with the cause', async () => {
    const notFound = Object.assign(new Error('NOT_FOUND'), { code: 5 })

    const explicit = createResolver(jest.fn().mockRejectedValue(notFound)).resolver.resolve('ml-scratch', 'request')
    await expect(explicit).rejects.toBeInstanceOf(BadRequestError)
    await expect(explicit).rejects.toMatchObject({ cause: notFound })

    const configured = createResolver(jest.fn().mockRejectedValue(notFound)).resolver.resolve(
      'ml-scratch',
      'configured',
    )
    await expect(configured).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expect(configured).rejects.toMatchObject({ cause: notFound })
  })

  it('rejects an ambiguous or not-ready instance', async () => {
    const ambiguous = {
      state: 2,
      networks: [{ ipAddresses: ['10.0.0.7', '10.0.0.8'] }],
      fileShares: [{ name: 'vol1' }],
    }
    const notReady = { ...readyInstance, state: 1 }
    const noShare = { state: 2, networks: [{ ipAddresses: ['10.0.0.7'] }], fileShares: [] }

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

  it('accepts the string enum shape alongside the numeric one', async () => {
    const { resolver } = createResolver(jest.fn().mockResolvedValue([{ ...readyInstance, state: 'READY' }]))

    await expect(resolver.resolve('ml-scratch', 'request')).resolves.toEqual({ server: '10.0.0.7', export: '/vol1' })
  })

  it('does not cache failed lookups', async () => {
    const getInstance = jest.fn().mockRejectedValue(new Error('transient GCP outage'))
    const { resolver } = createResolver(getInstance)

    await expect(resolver.resolve('ml-scratch', 'configured')).rejects.toThrow('Could not look up')
    await expect(resolver.resolve('ml-scratch', 'configured')).rejects.toThrow('Could not look up')

    // A failed lookup must reach the API again: caching the failure would pin
    // a transient outage into the 60s cache window.
    expect(getInstance).toHaveBeenCalledTimes(2)
  })

  it('rejects an instance exposing multiple file shares', async () => {
    const multiShare = { ...readyInstance, fileShares: [{ name: 'vol1' }, { name: 'vol2' }] }

    await expect(
      createResolver(jest.fn().mockResolvedValue([multiShare])).resolver.resolve('ml-scratch', 'request'),
    ).rejects.toThrow('exactly one IPv4 address and one file share')
  })

  it('preserves a GCP lookup failure in the log and exception cause', async () => {
    const gcpError = Object.assign(new Error('7 PERMISSION_DENIED: file.instances.get denied'), { code: 7 })
    const { resolver } = createResolver(jest.fn().mockRejectedValue(gcpError))
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    try {
      await expect(resolver.resolve('ml-scratch', 'configured')).rejects.toMatchObject({
        message:
          "Could not look up Filestore instance 'projects/boxlite-dev/locations/asia-southeast1-b/instances/ml-scratch'",
        cause: gcpError,
      })
      expect(logError).toHaveBeenCalledWith({
        event: 'filestore_lookup_failed',
        resourceName: 'projects/boxlite-dev/locations/asia-southeast1-b/instances/ml-scratch',
        source: 'configured',
        code: 7,
        message: gcpError.message,
      })
    } finally {
      logError.mockRestore()
    }
  })
})
