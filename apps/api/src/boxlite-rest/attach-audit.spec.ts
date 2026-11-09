/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { EventEmitter, once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'
import { Logger } from '@nestjs/common'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { AuditService } from '../audit/services/audit.service'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { AuditAction } from '../audit/enums/audit-action.enum'

// Keep the installed proxy's actual upgrade and error handling.
jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('attach audit over real WebSocket connections', () => {
  let frontend: Server
  let runner: Server
  let sockets: Set<Socket>
  let runnerWs: WebSocketServer
  let clients: WebSocket[]
  let rows: Map<string, AuditLog>
  let changed: EventEmitter
  let audit: AuditService
  let runnerConfig: { apiUrl: string; apiKey: string }
  let upgrades: IncomingMessage[]
  let downstream: Socket[]
  let refusal: number | 'reset' | 'hold' | undefined
  let authorized: boolean
  let base: string

  const snapshot = (row: AuditLog): AuditLog => ({ ...row, metadata: { ...row.metadata } })
  const attached = () => [...rows.values()].filter((row) => row.action === 'attach')
  const detached = () => [...rows.values()].filter((row) => row.action === 'detach')

  async function until(condition: () => boolean) {
    while (!condition()) await once(changed, 'change')
  }

  function openClient(mode = 'key', executionId = 'exec-1') {
    const query = mode === 'ticket' ? '?ticket=ticket-secret' : ''
    const client = new WebSocket(`${base}/api/v1/org-1/boxes/public-name/executions/${executionId}/attach${query}`, {
      headers: mode === 'ticket' ? {} : { authorization: `Bearer ${mode}-secret` },
    })
    client.on('error', () => undefined)
    clients.push(client)
    return client
  }

  const closed = (client: WebSocket) => new Promise<void>((resolve) => client.once('close', () => resolve()))

  beforeEach(async () => {
    sockets = new Set()
    clients = []
    rows = new Map()
    changed = new EventEmitter()
    upgrades = []
    downstream = []
    refusal = undefined
    authorized = true
    const repo = {
      insert: async (row: AuditLog) => {
        rows.set(row.id, snapshot(row))
        changed.emit('change')
      },
      findOne: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id)
        if (!row) throw new Error('Audit row not found')
        return snapshot(row)
      },
      save: async (row: AuditLog) => {
        rows.set(row.id, snapshot(row))
        changed.emit('change')
        return row
      },
    }
    audit = new AuditService(repo as never, { get: () => false } as never, {} as never, {} as never, {} as never)
    runnerWs = new WebSocketServer({ noServer: true })
    runner = createServer()
    runner.on('upgrade', (req, socket, head) => {
      upgrades.push(req)
      changed.emit('change')
      if (refusal === 'reset') return socket.destroy()
      if (refusal === 'hold') return
      if (refusal) return socket.end(`HTTP/1.1 ${refusal} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      runnerWs.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (message) => ws.send(message))
        runnerWs.emit('connection', ws, req)
      })
    })
    await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve))
    runnerConfig = { apiUrl: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`, apiKey: 'runner-secret' }
    const service = new BoxliteWsProxyService(
      {
        getApiKeyByValue: async (value: string) =>
          value === 'key-secret' ? { userId: 'key-user', organizationId: 'org-1', permissions: ['write:boxes'] } : null,
      } as never,
      { findOne: async () => (authorized ? { role: 'owner' } : null) } as never,
      { findOne: async () => ({ id: 'org-1' }) } as never,
      {
        findOneByIdOrName: async () => ({ id: 'canonical-box', runnerId: 'runner' }),
        updateLastActivityAt: async () => undefined,
      } as never,
      { findOne: async () => runnerConfig } as never,
      {} as never,
      { findOne: async (id: string) => ({ id, email: `${id}@example.test`, role: 'user' }) } as never,
      { verifyToken: async () => ({ sub: 'jwt-user' }) } as never,
      {
        consume: async () => ({
          userId: 'ticket-user',
          organizationId: 'org-1',
          boxId: 'canonical-box',
          execId: 'exec-1',
        }),
      } as never,
      audit,
    )
    frontend = createServer()
    frontend.on('upgrade', (req, socket, head) => {
      downstream.push(socket as Socket)
      void service.upgrade(req, socket as Socket, head)
    })
    for (const server of [frontend, runner])
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
    await new Promise<void>((resolve) => frontend.listen(0, '127.0.0.1', resolve))
    base = `ws://127.0.0.1:${(frontend.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const client of clients) client.terminate()
    for (const ws of runnerWs.clients) ws.terminate()
    for (const socket of sockets) socket.destroy()
    await Promise.all([frontend, runner].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    runnerWs.close()
  })

  it.each(['key', 'jwt', 'ticket'])(
    'records %s identity, canonical box and lifecycle without credentials or frames',
    async (mode) => {
      const client = openClient(mode)
      await once(client, 'open')
      await until(() => attached()[0]?.statusCode === 101)
      expect(detached()).toHaveLength(0)
      const attach = attached()[0]
      expect(attach.metadata?.connectionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(attach).toMatchObject({
        actorId: `${mode}-user`,
        actorEmail: `${mode}-user@example.test`,
        organizationId: 'org-1',
        targetId: 'canonical-box',
        targetType: 'box',
        metadata: { executionId: 'exec-1', connectedAt: expect.any(String) },
      })
      expect(upgrades[0].url).toBe('/v1/boxes/canonical-box/executions/exec-1/attach')
      const echo = once(client, 'message')
      client.send('terminal-private-sentinel')
      expect((await echo)[0].toString()).toBe('terminal-private-sentinel')
      const done = closed(client)
      client.close()
      await done
      await until(() => detached().length === 1)
      expect(detached()[0]).toMatchObject({
        actorId: attach.actorId,
        statusCode: 200,
        targetId: attach.targetId,
        metadata: {
          connectionId: attach.metadata?.connectionId,
          executionId: 'exec-1',
          connectedAt: attach.metadata?.connectedAt,
          disconnectedAt: expect.any(String),
          durationMs: expect.any(Number),
          hadError: false,
        },
      })
      expect(detached()[0].metadata?.durationMs).toBeGreaterThanOrEqual(0)
      expect(rows.size).toBe(2)
      expect(JSON.stringify([...rows.values()])).not.toMatch(/secret|terminal-private-sentinel/)
    },
  )

  it('records Runner closure exactly once despite errors and duplicate close events', async () => {
    const client = openClient()
    await once(client, 'open')
    const socket = downstream[0]
    socket.emit('error', new Error('transport-secret'))
    for (const ws of runnerWs.clients) ws.terminate()
    await until(() => detached().length === 1)
    socket.emit('close', true)
    expect(detached()).toHaveLength(1)
    expect(detached()[0].metadata?.hadError).toBe(true)
    expect(JSON.stringify([...rows.values()])).not.toContain('transport-secret')
  })

  it.each([403, 'reset', 'invalid-url'] as const)(
    'finishes a refused upgrade (%s) without a detach',
    async (failure) => {
      if (failure === 'invalid-url') runnerConfig.apiUrl = 'not a valid URL'
      else refusal = failure
      const client = openClient()
      await closed(client)
      await until(() => attached()[0]?.statusCode !== undefined)
      expect(attached()[0].statusCode).toBe(failure === 403 ? 403 : 0)
      expect(detached()).toHaveLength(0)
    },
  )

  it('refuses forwarding when the initial audit insert fails', async () => {
    jest.spyOn(audit, 'createLog').mockRejectedValueOnce(new Error('database-secret'))
    const client = openClient()
    await closed(client)
    expect(upgrades).toHaveLength(0)
    expect(rows.size).toBe(0)
  })

  it.each(['key', 'jwt', 'ticket'])('denies a %s without membership before auditing or forwarding', async (mode) => {
    authorized = false
    const client = openClient(mode)
    await closed(client)
    expect(upgrades).toHaveLength(0)
    expect(rows.size).toBe(0)
  })

  it('records unknown when a forwarded client disconnects before Runner accepts', async () => {
    refusal = 'hold'
    const client = openClient()
    await until(() => upgrades.length === 1)
    client.terminate()
    await until(() => attached()[0]?.statusCode === 0)
    expect(detached()).toHaveLength(0)
  })

  it('does not forward a client that disconnects while insertion is pending', async () => {
    const inserted = deferred()
    const release = deferred()
    const create = audit.createLog.bind(audit)
    jest.spyOn(audit, 'createLog').mockImplementationOnce(async (dto) => {
      inserted.resolve()
      await release.promise
      return create(dto)
    })
    const client = openClient()
    await inserted.promise
    const done = once(downstream[0], 'close')
    client.terminate()
    await done
    release.resolve()
    await until(() => attached()[0]?.statusCode === 0)
    expect(upgrades).toHaveLength(0)
    expect(detached()).toHaveLength(0)
  })

  it('records an immediate detach without waiting for attach persistence', async () => {
    const release = deferred()
    const update = audit.updateLog.bind(audit)
    jest.spyOn(audit, 'updateLog').mockImplementationOnce(async (id, dto) => {
      await release.promise
      return update(id, dto)
    })
    const client = openClient()
    await once(client, 'open')
    client.close()
    await until(() => detached().length === 1)
    expect(attached()[0].statusCode).toBeUndefined()
    expect(detached()[0].metadata?.connectedAt).toEqual(expect.any(String))
    release.resolve()
    await until(() => attached()[0].statusCode === 101)
    expect(attached()[0].metadata?.connectedAt).toBe(detached()[0].metadata?.connectedAt)
  })

  it('still records detach when completing attach fails', async () => {
    jest.spyOn(audit, 'updateLog').mockRejectedValueOnce(new Error('database-secret'))
    const client = openClient()
    await once(client, 'open')
    client.close()
    await until(() => detached().length === 1)
    expect(detached()[0].statusCode).toBe(200)
    expect(attached()[0].statusCode).toBeUndefined()
  })

  it('logs a fixed diagnostic once when detach insertion fails', async () => {
    const client = openClient()
    await once(client, 'open')
    const warned = deferred()
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => warned.resolve())
    const create = jest.spyOn(audit, 'createLog').mockRejectedValueOnce(new Error('database-secret'))
    client.close()
    await warned.promise
    downstream[0].emit('close', false)
    expect(create).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Failed to persist attach disconnect audit')
    expect(detached()).toHaveLength(0)
  })

  it('isolates concurrent sessions and completes attach before a session exceeds 30 minutes', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(100)
    const first = openClient('key', 'exec-first')
    const second = openClient('jwt', 'exec-second')
    await Promise.all([once(first, 'open'), once(second, 'open')])
    await until(() => attached().filter((row) => row.statusCode === 101).length === 2)
    clock.mockReturnValue(31 * 60 * 1000 + 100)
    const connectedRows = attached()
    expect(new Set(connectedRows.map((row) => row.metadata?.connectionId)).size).toBe(2)
    second.close()
    await until(() => detached().length === 1)
    expect(detached()[0]).toMatchObject({
      actorId: 'jwt-user',
      metadata: { executionId: 'exec-second', durationMs: 31 * 60 * 1000 },
    })
    expect(first.readyState).toBe(WebSocket.OPEN)
    first.close()
    await until(() => detached().length === 2)
    for (const attach of connectedRows) {
      const detach = detached().find((row) => row.metadata?.connectionId === attach.metadata?.connectionId)
      expect(detach).toMatchObject({ actorId: attach.actorId, metadata: { executionId: attach.metadata?.executionId } })
    }
  })
})

describe('completed audit insertion console output', () => {
  it.each([200, 0, undefined])('prints only completed inserts (status %s)', async (statusCode) => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    try {
      const service = new AuditService(
        { insert: async () => undefined } as never,
        { get: () => true } as never,
        {} as never,
        {} as never,
        {} as never,
      )
      const row = await service.createLog({ actorId: 'user', actorEmail: '', action: AuditAction.DETACH, statusCode })
      expect(log).toHaveBeenCalledTimes(statusCode === undefined ? 0 : 1)
      if (statusCode !== undefined) expect(log).toHaveBeenCalledWith(`AUDIT_ENTRY: ${JSON.stringify(row)}`)
    } finally {
      log.mockRestore()
    }
  })

  it('does not print completed records when disabled or insertion fails', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    try {
      const insert = jest.fn().mockResolvedValue(undefined)
      const config = { get: jest.fn().mockReturnValue(false) }
      const service = new AuditService({ insert } as never, config as never, {} as never, {} as never, {} as never)
      const dto = { actorId: 'user', actorEmail: '', action: AuditAction.DETACH, statusCode: 200 }
      await service.createLog(dto)
      config.get.mockReturnValue(true)
      insert.mockRejectedValue(new Error('insert failed'))
      await expect(service.createLog(dto)).rejects.toThrow('insert failed')
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
