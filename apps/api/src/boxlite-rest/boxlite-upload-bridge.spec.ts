/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { once } from 'node:events'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { bridgeUpload, createUploadWebSocketServer, UPLOAD_PROTOCOL } from './boxlite-upload-bridge'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

describe('file upload bridge', () => {
  let runner: Server
  let api: Server
  let client: WebSocket
  let peer: WebSocket
  let result: ReturnType<typeof bridgeUpload>
  let lease: AbortController

  async function connect(handler: RequestListener): Promise<void> {
    runner = createServer(handler)
    const runnerPort = await listen(runner)
    const ws = createUploadWebSocketServer()
    lease = new AbortController()
    api = createServer().on('upgrade', (req, socket, head) => {
      ws.handleUpgrade(req, socket, head, (webSocket) => {
        peer = webSocket
        result = bridgeUpload(
          peer,
          new URL(`http://127.0.0.1:${runnerPort}/v1/boxes/id/files?path=%2Fdst`),
          'runner-key',
          lease.signal,
        )
      })
    })
    client = new WebSocket(`ws://127.0.0.1:${await listen(api)}`, UPLOAD_PROTOCOL)
    await once(client, 'open')
  }

  afterEach(async () => {
    client?.terminate()
    peer?.terminate()
    await Promise.all(
      [api, runner].filter(Boolean).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
    )
  })

  it('streams a tar chunk to the private PUT before finish and returns 204 after EOF', async () => {
    let received = 0
    let firstChunk!: () => void
    const reachedRunner = new Promise<void>((resolve) => {
      firstChunk = resolve
    })
    await connect((req, res) => {
      expect(req.method).toBe('PUT')
      expect(req.url).toBe('/v1/boxes/id/files?path=%2Fdst')
      expect(req.headers.authorization).toBe('Bearer runner-key')
      expect(req.headers['transfer-encoding']).toBe('chunked')
      req.on('data', (data: Buffer) => {
        received += data.length
        firstChunk()
      })
      req.on('end', () => res.writeHead(204).end())
    })

    const message = once(client, 'message')
    client.send(Buffer.alloc(256 * 1024, 7))
    await reachedRunner
    expect(received).toBeGreaterThan(0)
    client.send(Buffer.from('tail'))
    client.send('finish')
    expect(JSON.parse((await message)[0].toString())).toEqual({ type: 'result', status: 204 })
    expect(received).toBe(256 * 1024 + 4)
    await expect(result).resolves.toEqual({ status: 204 })
  })

  it('returns a typed Runner refusal without waiting for the sender to finish', async () => {
    const error = { code: 'unsupported', message: 'cannot extract here' }
    await connect((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error }))
    })
    const [message] = await once(client, 'message')
    expect(JSON.parse(message.toString())).toEqual({ type: 'result', status: 400, error })
    await expect(result).resolves.toMatchObject({ status: 400, failure: 'http_400' })
  })

  it('closes oversized messages and aborts the upstream request', async () => {
    let notifyStarted!: () => void
    let notifyAborted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      notifyAborted = resolve
    })
    await connect((req) => {
      req.once('aborted', notifyAborted)
      notifyStarted()
      req.resume()
    })
    await started
    const closed = once(client, 'close')
    client.send(Buffer.alloc(256 * 1024 + 1))
    const [code] = await closed
    expect(code).toBe(1009)
    await expect(result).resolves.toMatchObject({ failure: 'websocket_error' })
    await aborted
  })

  it('rejects a premature Runner 204', async () => {
    await connect((_req, res) => res.writeHead(204).end())
    const [message] = await once(client, 'message')
    expect(JSON.parse(message.toString())).toEqual({ type: 'result', status: 502 })
    await expect(result).resolves.toMatchObject({ failure: 'unexpected_runner_response' })
  })

  it('aborts the relay if the audit lease is lost', async () => {
    await connect((req) => {
      req.resume()
    })
    const message = once(client, 'message')
    lease.abort()
    expect(JSON.parse((await message)[0].toString())).toMatchObject({ type: 'result', status: 503 })
    await expect(result).resolves.toMatchObject({ status: 503, failure: 'audit_lease_lost' })
  })
})
