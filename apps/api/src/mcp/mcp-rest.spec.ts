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

  it('rejects calls outside an authenticated invocation without contacting REST', async () => {
    await expect(rest.fetch('http://mcp-rest.invalid/boxes')).rejects.toMatchObject({ code: 'missing_context' })
    expect(calls).toBe(0)
  })

  it.each([new URL('https://untrusted.invalid/boxes'), new Request('https://untrusted.invalid/boxes')])(
    'routes a %p template through the authenticated loopback connection',
    async (input) => {
      respond = (req, res) => {
        expect(req.url).toBe('/api/v1/org-1/boxes')
        expect(req.headers.authorization).toBe('Bearer exact-value')
        res.end('{"boxes":[]}')
      }
      const response = await rest.run(request, new AbortController().signal, () => rest.fetch(input))
      expect(await response.json()).toEqual({ boxes: [] })
      expect(calls).toBe(1)
    },
  )

  it('accepts a JSON response exactly at the size limit', async () => {
    const value = 'x'.repeat(128 * 1024 - 2)
    respond = (_req, res) => res.end(JSON.stringify(value))
    const response = await call()
    expect(await response.json()).toBe(value)
    expect(request.res.listenerCount('close')).toBe(0)
  })

  it.each([200, 502])('rejects non-JSON REST responses with status %s', async (status) => {
    respond = (_req, res) => res.writeHead(status).end('<html>upstream unavailable</html>')
    await expect(call()).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'REST returned a non-JSON response',
    })
    expect(request.res.listenerCount('close')).toBe(0)
  })

  it.each([null, 'Forbidden', { message: ['Permission denied'] }, { error: 'Forbidden' }])(
    'preserves REST error details without a string message: %j',
    async (details) => {
      respond = (_req, res) => res.writeHead(403).end(JSON.stringify(details))
      await expect(call()).rejects.toMatchObject({
        code: 'http_error',
        message: 'REST returned HTTP 403',
        status: 403,
        details,
      })
      expect(request.res.listenerCount('close')).toBe(0)
    },
  )

  it('does not dispatch an invocation whose session is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      rest.run(request, controller.signal, () => rest.fetch('http://mcp-rest.invalid/boxes')),
    ).rejects.toMatchObject({ code: 'request_cancelled' })
    expect(calls).toBe(0)
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
