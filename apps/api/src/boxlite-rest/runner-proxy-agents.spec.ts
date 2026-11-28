/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { EventEmitter, once } from 'node:events'
import http, { type Server } from 'node:http'
import https from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import {
  RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS,
  RunnerProxyAgents,
} from './runner-proxy-agents'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDdB67hZztxH073
cq4p4CzJoRre5IFEv4y/7NRAqVW7akwBVqwBwfNeX1Ji0q8tYhXT1u/jNMBcZdRY
5zwDET326ZxYztYmhOY5rS+2JUQbEsPrnxGLOzm2N9l6xMqCXIeUtxsByzWyszVF
r35y6tps43oJL1aw5A2TOLbMlGB2SPpYzvdZcr0mt5xegRHEYkT9IJqzhO4IOM9Y
wMY8sO2kVEXVhxjWS9/j1VVNuykCzWD1AhGeo1+Cos1az6hNfK00NB32Ho9BzHdG
r2XPV0a0uyj4cgGUamzDmX30l6nSPybZSEQzloV4ZhSPvcA8G8ngODu3Z/q4FTqd
xEuPVzyjAgMBAAECggEBAIBIlkqClPBqAHYD3Gu3jacU1zionRJern0yIlrJLVYS
MrzQJhL7E5ohbvqmVz/a3tpNtHtFQaQfAej7hEwvdKxbGAA/Q/GlTs4I41kvNeEU
uhuF/jO2Ex/cOGBV2UdiFtrMj2MyIx9tfazNV3GxN0bdnBW6oPEX230n/IiuUXI0
gsB0WsoQJzALy8OhW8rcrWqxCakC6xnv9vFViL5T2xfx0FJztx5sLE7A0ahJNUNH
EKu/7HlH4pwEBK7kFSf14Ri4tVtJydk4dT/suXE867Rk/ErCkG/kldOek7NQesfy
PZdYbrZBvSb7nlUrbOktvYSPzsyA58b4cIQIZVLVIckCgYEA9ThdBL0dfugMY+qS
NpmNn9BF4FEVvesi1BdwiUqv0CS8xmx3LanFSOJv1ywJ0dU6ZbArShkYHqYc8W8m
g04RD/L5g1UmXAE1yU6hxg0H5pyfNiN2wmHwSUOlRDeJdppyRiXpGLe42nScPJQ/
qNGLiGh1GUZEpNSsd/TVpQwwHy8CgYEA5r8XPDePjXxivJDI8sMgj52Y3qyEd+Zc
h3cZQ7lB25cMJul7ifJ+xx7r36VkVeqLhJoIoQ6CeJh5toHqfsy4ioU2f34GX47H
bjy+IwpQomKppLjQ7qVgXsrTZJ4uszLCWRMd30kd0YHXcYdUUqASVz64ieQgg3yi
4UCqzMyk/M0CgYEA4wRLGRf7NoGc9uMyeVmuw0UNa52lgy0sES2iAXgjS463NPs1
WhDRk6gN4iXi8V91sK5nZTHWIommQd2kyep74UgPtoYd/Q8hvDwPiEqIBfb5biVm
zI3e5fS6C21e1W4mXMq8ASYU/Cj4exzD0oYrpx0NS1jCM9av1F3Va/bclgECgYAq
bgsEvKa9+phhWjJJSY4sOmuIzqpRLd/n3QOdS2yLx3upkBdyZ0/ep5Xx+wS3M7jR
+k0J6JQfPtJqt/r5tAVfG13JFdBwM94CLFM+OEBZi9DsBDwPFgPhimRSxS+LLhNE
s9ozW8uK4dhO/PaJdvvIZTUjzfoYk4uT5gNCQ4M3JQKBgBJS+hGbhgWzSrHDhuC6
pkyi6ao7bxpv1T2rg4ehxsgAPzGc7n1Mn1yr5uF0U3/DYi3uJvVrIAvvUwXPsN7R
1XqUo9pMFAH1PZsMDg8r00ScXCA2MIF/IylJ2299DmDD98E8Mz0uGK3d2hGWOvTs
7jx/4gVnT4wfnjhWZ4obRlcE
-----END PRIVATE KEY-----`
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQC8FarCXpuKsTANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjYxMTI4MDYzMjEwWhcNMzYxMTI1MDYzMjEwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDd
B67hZztxH073cq4p4CzJoRre5IFEv4y/7NRAqVW7akwBVqwBwfNeX1Ji0q8tYhXT
1u/jNMBcZdRY5zwDET326ZxYztYmhOY5rS+2JUQbEsPrnxGLOzm2N9l6xMqCXIeU
txsByzWyszVFr35y6tps43oJL1aw5A2TOLbMlGB2SPpYzvdZcr0mt5xegRHEYkT9
IJqzhO4IOM9YwMY8sO2kVEXVhxjWS9/j1VVNuykCzWD1AhGeo1+Cos1az6hNfK00
NB32Ho9BzHdGr2XPV0a0uyj4cgGUamzDmX30l6nSPybZSEQzloV4ZhSPvcA8G8ng
ODu3Z/q4FTqdxEuPVzyjAgMBAAEwDQYJKoZIhvcNAQELBQADggEBADpda9bq2cKQ
w4N8jSjGCeA0IkvS3bpWg5qq6BPq0GgvvP+wldJDqCgrzpnYoRLuK7hZRRIt/1h+
yWcmlH5JDOi+y5qpBt4Ic6AdB+4mFdixW2PA+rfEIu44/EO30fSutXnW3jmQZ5+3
CQuiwj4mO9eYIWiKaLWvXZp0h+clKTSHv1iArkL/AgMiyUNOIrlhi4Mo56TnKuUt
DwNH2aiDzzW2i30V1gGJ+Yk1Z58wcCKsu2KDqL1eIPpT5+m46ISKiuyF6hiMw6tB
cOcxvxEvVt7lcTiKyQSTukXROXW9GE4LOtPjPklrt08fJv7CGSY589d/kKjGpjqQ
xtq03/o8mo8=
-----END CERTIFICATE-----`

type TestAgentPool = RunnerProxyAgents

describe.each(['http', 'https'] as const)('shared runner proxy agents over %s', (protocol) => {
  let runner: Server
  let otherRunner: Server
  let frontend: Server
  let runnerWs: WebSocketServer
  let otherRunnerWs: WebSocketServer
  let clients: WebSocket[]
  let sockets: Set<Socket>
  let target: string
  let otherTarget: string
  let connections: number
  let otherConnections: number
  let requestPorts: Array<number | undefined>
  let upgradePorts: Array<number | undefined>
  let upgradeSockets: Socket[]
  let upgradeMode: 'accept' | 'reset' | 'hold'
  let holdResponses: boolean
  let heldResponse: http.ServerResponse | undefined
  let agents: TestAgentPool

  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const createRunner = async (isOther = false) => {
    const requests: Array<number | undefined> = []
    const upgrades: Array<number | undefined> = []
    const upgradedSockets: Socket[] = []
    const wss = new WebSocketServer({ noServer: true })
    const server = protocol === 'https' ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }) : http.createServer()
    server.on('request', (req, res) => {
      requests.push(req.socket.remotePort)
      if (holdResponses && !heldResponse) {
        heldResponse = res
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    server.on('upgrade', (req, socket, head) => {
      upgrades.push(req.socket.remotePort)
      upgradedSockets.push(socket as Socket)
      if (upgradeMode === 'reset') return socket.destroy()
      if (upgradeMode === 'hold') return
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (message) => ws.send(message))
        wss.emit('connection', ws, req)
      })
    })
    server.on('connection', (socket) => {
      const netSocket = socket as Socket
      sockets.add(netSocket)
      if (isOther) otherConnections++
      else connections++
      socket.once('close', () => sockets.delete(netSocket))
    })
    const httpBase = await listen(server)
    return { server, wss, requests, upgrades, upgradedSockets, target: httpBase.replace('http:', `${protocol}:`) }
  }

  beforeEach(async () => {
    sockets = new Set()
    clients = []
    connections = 0
    otherConnections = 0
    upgradeMode = 'accept'
    holdResponses = false
    heldResponse = undefined
    agents = new RunnerProxyAgents()
    const first = await createRunner()
    runner = first.server
    runnerWs = first.wss
    target = first.target
    requestPorts = first.requests
    upgradePorts = first.upgrades
    upgradeSockets = first.upgradedSockets
    const second = await createRunner(true)
    otherRunner = second.server
    otherRunnerWs = second.wss
    otherTarget = second.target

    const controller = new (BoxliteProxyController as any)(
      {
        findOneByIdOrName: async () => ({
          id: 'canonical-box',
          organizationId: 'org-1',
          runnerId: 'runner',
          autoResume: false,
          autoStop: 0,
          state: 'started',
          desiredState: 'started',
        }),
        updateLastActivityAt: async () => undefined,
      },
      { findProxyTarget: async () => ({ apiUrl: target, apiKey: 'runner-key' }) },
      {},
      {},
      agents,
    )
    const wsProxy = new (BoxliteWsProxyService as any)(
      {
        findApiKey: async () => ({
          organizationId: 'org-1',
          userId: 'user-1',
          permissions: ['write:boxes'],
          expiresAt: null,
        }),
        findUser: async () => ({ userId: 'user-1', role: 'user', email: 'user@example.test' }),
      },
      { findOne: async () => ({ role: 'owner' }) },
      { findOne: async () => ({ id: 'org-1' }) },
      {
        findOneByIdOrName: async () => ({ id: 'canonical-box', runnerId: 'runner', autoResume: false }),
        updateLastActivityAt: async () => undefined,
      },
      { findProxyTarget: async () => ({ apiUrl: target, apiKey: 'runner-key' }) },
      {},
      undefined,
      { consume: async () => null },
      { createLog: async () => ({ id: 'audit' }), updateLog: async () => undefined },
      agents,
    )
    Object.assign(wsProxy, {
      redis: {
        get: async () => null,
        eval: async () => 1,
      },
    })

    frontend = http.createServer((req, res) => {
      Object.assign(req, {
        user: { userId: 'user-1', role: 'user', email: 'user@example.test', organizationId: 'org-1' },
        get: (name: string) => req.headers[name.toLowerCase()],
      })
      void controller
        .proxyExec({ organizationId: 'org-1', organization: { id: 'org-1' } }, 'public-box', req, res, () => undefined)
        .catch(() => res.writeHead(500).end())
    })
    frontend.on('upgrade', (req, socket, head) => void wsProxy.upgrade(req, socket, head))
    frontend.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await listen(frontend)
  })

  afterEach(async () => {
    for (const client of clients) client.terminate()
    for (const wss of [runnerWs, otherRunnerWs]) {
      for (const client of wss.clients) client.terminate()
      wss.close()
    }
    for (const socket of sockets) socket.destroy()
    agents.onModuleDestroy()
    await Promise.all(
      [frontend, runner, otherRunner].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
  })

  const post = async () => {
    const address = frontend.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/boxes/public-box/exec`, { method: 'POST' })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  }

  const attach = () => {
    const address = frontend.address() as AddressInfo
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/org-1/boxes/public-box/executions/exec-1/attach`,
      { headers: { authorization: 'Bearer key' } },
    )
    client.on('error', () => undefined)
    clients.push(client)
    return client
  }

  it('reuses the POST connection for WS upgrade without pooling the upgraded socket or crossing origins', async () => {
    await post()
    expect(requestPorts).toHaveLength(1)
    const client = attach()
    await once(client, 'open')

    expect(upgradePorts).toEqual([requestPorts[0]])
    expect(connections).toBe(1)
    const agent = agents.forTarget(target)
    const free = Object.values(agent.freeSockets).flat()
    expect(free).not.toContain(upgradeSockets[0])
    expect(free).toHaveLength(0)

    const echo = once(client, 'message')
    client.send('active')
    expect((await echo)[0].toString()).toBe('active')

    target = otherTarget
    await post()
    expect(otherConnections).toBe(1)
    expect(connections).toBe(1)
  })

  it('releases a failed handshake without leaving an active or free upstream socket', async () => {
    await post()
    upgradeMode = 'reset'
    const client = attach()
    await new Promise<void>((resolve) => client.once('close', () => resolve()))

    const agent = agents.forTarget(target)
    expect(Object.values(agent.sockets).flat()).toHaveLength(0)
    expect(Object.values(agent.freeSockets).flat()).toHaveLength(0)
  })

  it('does not return a server-closed WebSocket to the free pool', async () => {
    await post()
    const client = attach()
    await once(client, 'open')
    const closed = once(client, 'close')
    for (const upstream of runnerWs.clients) upstream.terminate()
    await closed

    const agent = agents.forTarget(target)
    expect(Object.values(agent.sockets).flat()).toHaveLength(0)
    expect(Object.values(agent.freeSockets).flat()).toHaveLength(0)
  })

  it('applies the total socket bound across different Runner origins', async () => {
    const agent = agents.forTarget(target)
    agent.maxTotalSockets = 1
    holdResponses = true
    const first = post()
    for (let attempt = 0; !heldResponse && attempt < 50; attempt++) await new Promise(setImmediate)
    expect(heldResponse).toBeDefined()

    target = otherTarget
    let secondFinished = false
    const second = post().then(() => {
      secondFinished = true
    })
    for (let attempt = 0; attempt < 5; attempt++) await new Promise(setImmediate)
    expect(secondFinished).toBe(false)
    expect(otherConnections).toBe(0)

    holdResponses = false
    heldResponse!.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    await first
    await second
    expect(otherConnections).toBe(1)
  })
})

describe('RunnerProxyAgents idle socket lifecycle', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  function idleSocket() {
    return Object.assign(new EventEmitter(), {
      writable: true,
      _httpMessage: { shouldKeepAlive: true },
      setKeepAlive: jest.fn(),
      setTimeout: jest.fn(),
      unref: jest.fn(),
      ref: jest.fn(),
      destroy: jest.fn(function (this: EventEmitter) {
        this.emit('close')
      }),
    }) as unknown as Socket
  }

  function setFreeSockets(agent: http.Agent, sockets: Socket[]) {
    ;(agent.freeSockets as Record<string, Socket[]>)[agent.getName({})] = sockets
  }

  function emitFree(agent: http.Agent, socket: Socket) {
    Object.assign(socket, { writable: true, _httpMessage: { shouldKeepAlive: true } })
    agent.emit('free', socket, {})
  }

  it('bounds per-origin and per-protocol capacity and expires only sockets still free', () => {
    const agents = new RunnerProxyAgents()
    expect((agents.http as any).options).toMatchObject({ keepAlive: true })
    expect((agents.https as any).options).toMatchObject({ keepAlive: true })
    expect(agents.http.maxSockets).toBe(64)
    expect(agents.https.maxSockets).toBe(64)
    expect(agents.http.maxFreeSockets).toBe(16)
    expect(agents.https.maxFreeSockets).toBe(16)
    expect(agents.http.maxTotalSockets).toBe(512)
    expect(agents.https.maxTotalSockets).toBe(512)

    const socket = idleSocket()
    emitFree(agents.http, socket)
    jest.advanceTimersByTime(RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS - 1)
    expect(socket.destroy).not.toHaveBeenCalled()
    setFreeSockets(agents.http, [])
    agents.http.emit('reuse', socket, {})
    jest.advanceTimersByTime(RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS * 2)
    expect(socket.destroy).not.toHaveBeenCalled()

    emitFree(agents.http, socket)
    jest.advanceTimersByTime(RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    setFreeSockets(agents.http, [])
    agents.onModuleDestroy()
  })

  it('clears pending idle collection on module shutdown', () => {
    const agents = new RunnerProxyAgents()
    const socket = idleSocket()
    emitFree(agents.https, socket)
    agents.onModuleDestroy()
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS * 2)
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })
})
