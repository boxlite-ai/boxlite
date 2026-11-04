import { createServer, Server } from 'node:http'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'

describe('V0 nested virtualization wire contract', () => {
  let server: Server
  let adapter: RunnerAdapterV0
  let saved: boolean | undefined
  let requests: { method: string; path: string; authorization: string; contentType: string; body: unknown }[]

  beforeEach(async () => {
    requests = []
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      requests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : undefined,
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ state: 'started', nestedVirtualization: saved }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing HTTP address')
    adapter = new RunnerAdapterV0()
    await adapter.init(
      Object.assign(
        new Runner({
          region: 'local',
          name: 'wire',
          apiKey: 'runner-key',
          apiVersion: '0',
          apiUrl: `http://127.0.0.1:${address.port}`,
          cpu: 1,
          memoryGiB: 1,
          diskGiB: 1,
        }),
      ),
    )
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it.each(['create', 'recover'])('%s omits ordinary intent and forwards only saved true', async (operation) => {
    const box = Object.assign(new Box('local', 'wire'), { id: 'cloud-box', errorReason: 'recover' })
    for (const value of [undefined, false, true]) {
      box.nestedVirtualization = value
      if (operation === 'create') await adapter.createBox(box, 'alpine:latest')
      else await adapter.recoverBox(box)
    }
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: operation === 'create' ? '/boxes' : '/boxes/cloud-box/recover',
      authorization: 'Bearer runner-key',
      contentType: 'application/json',
    })
    expect(requests[0].body).not.toHaveProperty('nestedVirtualization')
    expect(requests[2].body).toEqual({ ...(requests[0].body as object), nestedVirtualization: true })
  })

  it.each([undefined, false, true])('projects native saved %j without coercing unknown', async (value) => {
    saved = value
    expect((await adapter.boxInfo('cloud-box')).nestedVirtualization).toBe(value)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/boxes/cloud-box', authorization: 'Bearer runner-key' })
  })
})
