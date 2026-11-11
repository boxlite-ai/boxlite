import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { BoxApi, Configuration } from '@boxlite-ai/runner-api-client'
import { RunnerAdapterV0 } from './runnerAdapter.v0'

describe('Runner optional cold-start request', () => {
  let server: Server
  let basePath: string
  let received: { method: string; path: string; query: URLSearchParams; body: unknown }[]

  beforeEach(async () => {
    received = []
    server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const url = new URL(request.url, 'http://runner.test')
      received.push({ method: request.method, path: url.pathname, query: url.searchParams, body: body ? JSON.parse(body) : undefined })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ daemonVersion: 'runner-test' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    basePath = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it.each([undefined, false, true])('serializes the optional choice %p without shifting token or metadata', async (choice) => {
    const client = new BoxApi(new Configuration({ basePath }))
    await client.start('box', choice, 'box-token', { request: 'trace' }, { proxy: false })
    expect(received).toHaveLength(1)
    expect(received[0].method).toBe('POST')
    expect(received[0].path).toBe('/boxes/box/start')
    expect(received[0].query.get('token')).toBe('box-token')
    expect(received[0].query.get('nestedVirtualization')).toBe(choice === undefined ? null : String(choice))
    expect(received[0].body).toEqual({ request: 'trace' })
  })

  it('preserves the existing V0 consumer request when no Cloud policy is supplied', async () => {
    const adapter = new RunnerAdapterV0()
    await adapter.init({ id: 'runner', apiUrl: basePath, apiKey: 'runner-token' } as any)
    await adapter.startBox('box', 'box-token', { request: 'trace' })
    expect(received).toHaveLength(1)
    expect(received[0].query.get('nestedVirtualization')).toBeNull()
    expect(received[0].query.get('token')).toBe('box-token')
    expect(received[0].body).toEqual({ request: 'trace' })
  })
})
