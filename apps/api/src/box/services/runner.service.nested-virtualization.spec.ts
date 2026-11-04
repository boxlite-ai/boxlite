import { createServer, Server } from 'node:http'
import { RunnerService } from './runner.service'
import { RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxClass } from '../enums/box-class.enum'

describe('nested virtualization Runner eligibility over HTTP', () => {
  let server: Server
  let url: string
  let capability: unknown
  let omit: boolean
  let hold: boolean
  let requests: string[]

  beforeEach(async () => {
    capability = true
    omit = false
    hold = false
    requests = []
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      expect(req.headers.authorization).toBe('Bearer runner-key')
      if (hold) return
      const body = JSON.stringify(
        omit
          ? {}
          : {
              nestedVirtualizationEnabled: req.url === '/compatible/info' ? true : capability,
            },
      )
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    url = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function runner(id: string, apiVersion = '0', availabilityScore = 100): Runner {
    return Object.assign(
      new Runner({
        region: 'local',
        name: id,
        apiKey: 'runner-key',
        apiVersion,
        apiUrl: url,
        cpu: 64,
        memoryGiB: 128,
        diskGiB: 1024,
      }),
      { id, apiUrl: url, state: RunnerState.READY, class: BoxClass.SMALL, availabilityScore },
    )
  }

  function service(runners: Runner[], enabled = true, timeout = 1) {
    const repository = { find: jest.fn().mockResolvedValue(runners) }
    const factory = new RunnerAdapterFactory({ create: async () => new RunnerAdapterV0() } as never)
    const create = jest.spyOn(factory, 'create')
    const instance = Object.create(RunnerService.prototype) as RunnerService
    Object.assign(instance, {
      runnerRepository: repository,
      runnerAdapterFactory: factory,
      logger: { debug: jest.fn() },
      configService: {
        get: (key) => (key === 'nestedVirtualizationEnabled' ? enabled : timeout),
        getOrThrow: () => 0,
      },
    })
    return { instance, repository, create }
  }

  it('leaves ordinary candidate lookup unchanged without probing', async () => {
    const old = runner('old', '2')
    const { instance, repository, create } = service([old])
    expect(await instance.findAvailableRunners({})).toEqual([old])
    expect(repository.find.mock.calls[0][0].where).not.toHaveProperty('apiVersion')
    expect(create).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('selects explicitly enabled V0, excludes V2, and probes fresh on rollback', async () => {
    const compatible = runner('compatible')
    const { instance, repository, create } = service([compatible, runner('v2', '2')])
    expect(await instance.findAvailableRunners({ nestedVirtualization: true })).toEqual([compatible])
    expect(repository.find.mock.calls[0][0].where).toMatchObject({ apiVersion: '0', state: RunnerState.READY })
    expect(create).toHaveBeenCalledTimes(1)
    expect(requests).toEqual(['GET /info'])
    capability = false
    await expect(instance.getRandomAvailableRunner({ nestedVirtualization: true })).rejects.toThrow(
      'No available runners',
    )
    expect(requests).toEqual(['GET /info', 'GET /info'])
  })

  it.each([false, null, 'true', 1, {}, []])('never treats advertised %j as true', async (value) => {
    capability = value
    const { instance } = service([runner('unsupported')])
    expect(await instance.findAvailableRunners({ nestedVirtualization: true })).toEqual([])
  })

  it('refuses an old missing advertisement and stops on disabled operator authorization before probing', async () => {
    omit = true
    const { instance } = service([runner('old')])
    expect(await instance.findAvailableRunners({ nestedVirtualization: true })).toEqual([])
    const disabled = service([runner('disabled')], false)
    await expect(disabled.instance.findAvailableRunners({ nestedVirtualization: true })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'unsupported' }),
    })
    expect(disabled.repository.find).not.toHaveBeenCalled()
    expect(requests).toEqual(['GET /info'])
  })

  it('aborts an unresponsive probe at the shared deadline', async () => {
    hold = true
    const { instance } = service([runner('unresponsive')], true, 0.03)
    expect(await instance.findAvailableRunners({ nestedVirtualization: true })).toEqual([])
    expect(requests).toEqual(['GET /info'])
  })

  it('keeps the bounded top-ten search even when compatible capacity is ranked eleventh', async () => {
    capability = false
    const candidates = Array.from({ length: 11 }, (_, index) => runner(`rank-${index}`, '0', 100 - index))
    candidates[10].apiUrl = `${url}/compatible`
    const { instance, create } = service(candidates)
    await instance.requireNestedVirtualization(candidates[10])
    expect(requests).toEqual(['GET /compatible/info'])
    requests = []
    create.mockClear()
    expect(await instance.findAvailableRunners({ nestedVirtualization: true })).toEqual([])
    expect(create).toHaveBeenCalledTimes(10)
    expect(create.mock.calls.some(([selected]) => selected.id === 'rank-10')).toBe(false)
    expect(requests).toHaveLength(10)
  })
})
