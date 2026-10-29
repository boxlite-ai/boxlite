/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { McpRunnerClient } from './mcp-runner.client'
import { RunnerService } from '../box/services/runner.service'
import { Box } from '../box/entities/box.entity'

describe('McpRunnerClient', () => {
  let server: Server
  let sockets: WebSocketServer
  let client: McpRunnerClient
  const box = { id: 'box-1', runnerId: 'runner-1' } as Box
  const requests: { path: string; token?: string; body: string }[] = []
  beforeEach(async () => {
    requests.length = 0
    server = createServer(async (req, res) => {
      let body = ''
      for await (const part of req) body += part
      requests.push({ path: req.url!, token: req.headers.authorization, body })
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify(req.method === 'POST' ? { execution_id: 'exec-1' } : { status: 'completed', exit_code: 7 }),
      )
    })
    sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      requests.push({ path: req.url!, token: req.headers.authorization, body: '' })
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    client = new McpRunnerClient({
      findOne: async () => ({
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: 'runner-only-key',
      }),
    } as unknown as RunnerService)
  })
  afterEach(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => sockets.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  it('forwards argument arrays and a bounded runtime using only server credentials', async () => {
    expect(
      await client.start(
        box,
        { box_id: box.id, command: 'printf', args: ['hello; no shell'], timeout_seconds: 60 },
        new AbortController().signal,
      ),
    ).toBe('exec-1')
    expect(requests[0]).toMatchObject({ path: '/v1/boxes/box-1/exec', token: 'Bearer runner-only-key' })
    expect(JSON.parse(requests[0].body)).toMatchObject({
      command: 'printf',
      args: ['hello; no shell'],
      timeout_seconds: 60,
      tty: false,
    })
    expect(await client.status(box, 'exec-1')).toEqual({ status: 'completed', exit_code: 7 })
    await client.cancel(box, 'exec-1')
  })
  it('drains asynchronous output writes before accepting a fast nonzero exit', async () => {
    sockets.on('connection', (ws) => {
      ws.send(Buffer.from([1, 0xe4, 0xb8]))
      ws.send(Buffer.from([1, 0xad]))
      ws.send(Buffer.concat([Buffer.from([2]), Buffer.from('error')]))
      ws.send(JSON.stringify({ type: 'exit', exit_code: 7 }))
      ws.close()
    })
    const received: { stream: string; bytes: Buffer }[] = []
    const code = await client.collect(box, 'exec-1', new AbortController().signal, async (stream, bytes) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      received.push({ stream, bytes })
    })
    expect(code).toBe(7)
    expect(
      Buffer.concat(received.filter((item) => item.stream === 'stdout').map((item) => item.bytes)).toString(),
    ).toBe('中')
    expect(received.at(-1)!.bytes.toString()).toBe('error')
  })
  it('rejects missing exit frames and closes its socket on abort', async () => {
    sockets.once('connection', (ws) => ws.close())
    await expect(client.collect(box, 'exec-1', new AbortController().signal, async () => undefined)).rejects.toThrow(
      'without exit',
    )
    const abort = new AbortController()
    sockets.once('connection', () => abort.abort())
    await expect(client.collect(box, 'exec-1', abort.signal, async () => undefined)).rejects.toThrow('stopped')
  })
})
