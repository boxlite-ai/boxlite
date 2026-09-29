/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import express from 'express'
import { BoxliteProxyController } from './boxlite-proxy.controller'

describe('Hosted exec timeout HTTP forwarding', () => {
  let runner: Server
  let apiServer: Server
  let apiUrl: string

  beforeAll(async () => {
    const echo = express().use(express.raw({ type: 'application/json' }))
    echo.use((req, res) => {
      res.json({
        body: JSON.parse(req.body.toString()),
        length: req.headers['content-length'],
        bytes: req.body.length,
        path: req.url,
      })
    })
    runner = createServer(echo)
    await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve))
    const target = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`
    const controller = new BoxliteProxyController(
      {
        findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'internal-box', runnerId: 'runner-1' }),
        updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
      } as never,
      { findOne: jest.fn().mockResolvedValue({ apiUrl: target, apiKey: 'test-runner-key' }) } as never,
      {} as never,
    )
    const api = express().use(express.json())
    api.post(['/v1/boxes/:boxId/exec', '/v1/:prefix/boxes/:boxId/exec'], (req, res, next) => {
      const defaults: Record<string, number | null> = { inherited: null, 'long-tasks': 1800, unlimited: 0 }
      const organization = { defaultExecTimeoutSeconds: defaults[String(req.params.prefix)] }
      const auth = { organizationId: String(req.params.prefix ?? 'default-org'), organization }
      void controller.proxyExec(auth as never, String(req.params.boxId), req, res, next).catch(next)
    })
    apiServer = createServer(api)
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
    apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    for (const server of [apiServer, runner]) {
      server?.closeAllConnections()
      if (server?.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it.each([
    ['', undefined, 300],
    ['/inherited', null, 300],
    ['/long-tasks', undefined, 1800],
    ['/long-tasks', null, 1800],
    ['/long-tasks', 1.5, 1.5],
    ['/long-tasks', 600, 600],
    ['/long-tasks', 0, 0],
    ['/unlimited', undefined, 0],
    ['/unlimited', 600, 600],
  ])('serializes the effective timeout for %s (explicit %s)', async (prefix, explicit, expected) => {
    const body = {
      command: 'echo',
      args: ['你好'],
      env: { MODE: 'test' },
      working_dir: '/tmp',
      tty: explicit === 0,
      timeout_seconds: explicit,
    }
    const response = await fetch(`${apiUrl}/v1${prefix}/boxes/public-box/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    expect(response.status).toBe(200)
    const received = (await response.json()) as { body: unknown; length: string; bytes: number; path: string }
    expect(received.body).toEqual({ ...body, timeout_seconds: expected })
    expect(Number(received.length)).toBe(received.bytes)
    expect(received.path).toBe('/v1/boxes/internal-box/exec')
  })
})
