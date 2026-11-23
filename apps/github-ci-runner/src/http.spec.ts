/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { AddressInfo, connect } from 'node:net'
import { Listener } from '@boxlite-ai/ci-listener'
import { createHttp } from './http'

it('delivers the complete 413 response before closing an oversized upload socket', async () => {
  const receive = jest.fn()
  const http = createHttp(
    { receive } as unknown as Listener,
    { discoveryReady: true, report: jest.fn() },
    Buffer.alloc(32, 1),
  )
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve))
  let response = ''
  const socket = connect((http.server.address() as AddressInfo).port, '127.0.0.1')
  const closed = new Promise<void>((resolve) => {
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })
    socket.on('error', () => {})
    socket.on('close', () => resolve())
  })
  const timer = setTimeout(() => socket.destroy(), 3000)
  try {
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      'POST /v1/ci/github/webhook HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n',
    )
    socket.write(Buffer.alloc(1048577, 32))
    await closed
    expect(response).toContain('HTTP/1.1 413')
    expect(response).toContain('{"error":"payload_limit"}')
    expect(response.toLowerCase()).toContain('connection: close')
    expect(receive).not.toHaveBeenCalled()
  } finally {
    clearTimeout(timer)
    socket.destroy()
    await http.close()
  }
})
