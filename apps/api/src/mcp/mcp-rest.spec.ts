/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { createServer, Server } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { McpRest } from './mcp-rest'

describe('MCP loopback REST boundary', () => {
  let server: Server
  let request: any
  let calls: number
  let respond: (req: any, res: any) => void
  function call(boxId = 'box-1', method = 'GET') {
    return rest.run(request, new AbortController().signal, () =>
      rest.fetch(`http://mcp-rest.invalid/boxes/${encodeURIComponent(boxId)}`, { method }),
    )
  }
  const organizations = { findDefaultForUser: jest.fn(async () => ({ id: 'org-1' })) }
  const rest = new McpRest(organizations as any)

  beforeEach(async () => {
    calls = 0
    server = createServer((req, res) => {
      calls++
      respond(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    request = {
      user: { userId: 'user-1' },
      headers: { authorization: 'Bearer exact-value', host: 'attacker.invalid' },
      socket: { localPort: (server.address() as any).port },
      res: new EventEmitter(),
    }
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('encodes resource names without allowing the client to select a host or parent path', async () => {
    respond = (req, res) => {
      expect(req.url).toBe('/api/v1/org-1/boxes/name%2F..%2Fother%3Fquery%23fragment')
      expect(req.headers.authorization).toBe('Bearer exact-value')
      res.end('{}')
    }
    await call('name/../other?query#fragment')
    expect(calls).toBe(1)
    expect(request.res.listenerCount('close')).toBe(0)
  })

  it('rejects oversized responses and releases the REST connection', async () => {
    let closed: Promise<unknown>
    respond = (_req, res) => {
      closed = once(res, 'close')
      res.write('x'.repeat(128 * 1024 + 1))
    }
    await expect(call()).rejects.toThrow('128 KiB')
    await closed
    expect(calls).toBe(1)
    expect(request.res.listenerCount('close')).toBe(0)
  })

  it('does not follow redirects or retry a mutation', async () => {
    respond = (_req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${(server.address() as any).port}/unexpected` }).end()
    await expect(call('box-1', 'POST')).rejects.toThrow('operation may have completed')
    expect(calls).toBe(1)
  })

  it('cancels the outgoing request when the MCP response closes', async () => {
    let received: () => void
    const arrival = new Promise<void>((resolve) => {
      received = resolve
    })
    let closed: Promise<unknown>
    respond = (_req, res) => {
      closed = once(res, 'close')
      received()
    }
    const pending = call()
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await arrival
    request.res.emit('close')
    await rejected
    await closed
    expect(request.res.listenerCount('close')).toBe(0)
  })

  it('bounds a stalled REST response without retrying', async () => {
    respond = () => undefined
    const started = Date.now()
    await expect(call()).rejects.toThrow('exceeded its bound')
    expect(Date.now() - started).toBeLessThan(40_000)
    expect(calls).toBe(1)
    expect(request.res.listenerCount('close')).toBe(0)
  }, 45_000)
})
