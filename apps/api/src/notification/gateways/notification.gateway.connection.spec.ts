/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { Logger } from '@nestjs/common'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server, type Socket } from 'socket.io'
import { io, type Socket as ClientSocket } from 'socket.io-client'
import { NotificationGateway } from './notification.gateway'

let server: Server
let client: ClientSocket

afterEach(async () => {
  client?.disconnect()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  jest.restoreAllMocks()
})

async function connect(findOne: jest.Mock, validToken = true) {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  const http = createServer()
  server = new Server(http, { path: '/api/socket.io/', transports: ['websocket'] })
  const attempts: Socket[] = []
  server.use((socket, next) => {
    attempts.push(socket)
    next()
  })
  const jwt = {
    verifyToken: jest.fn().mockImplementation(async () => {
      if (!validToken) throw new Error('Invalid token')
      return { sub: 'user-1' }
    }),
  }
  const apiKeys = { validate: jest.fn().mockResolvedValue(null) }
  const membership = { exists: jest.fn().mockResolvedValue(true) }
  const gateway = new NotificationGateway(
    jwt as never,
    apiKeys as never,
    membership as never,
    {} as never,
    { findOne } as never,
  )
  gateway.afterInit(server)
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  client = io(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
    path: '/api/socket.io/',
    transports: ['websocket'],
    autoConnect: false,
    auth: { token: 'token' },
    query: { organizationId: 'org-1' },
    reconnectionDelay: 1,
    reconnectionDelayMax: 1,
    randomizationFactor: 0,
    reconnectionAttempts: 3,
    timeout: 1000,
  })
  const outcome = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification connection did not settle')), 2000)
    const finish = (result: string) => {
      clearTimeout(timer)
      resolve(result)
    }
    client.once('connect', () => finish('connected'))
    client.on('connect_error', () => {
      if (!client.active) finish('refused')
    })
    client.io.once('reconnect_failed', () => finish('exhausted'))
    client.connect()
  })
  return { outcome, attempts, apiKeys, membership }
}

describe('NotificationGateway transport recovery', () => {
  it('retries a failed user lookup without admitting the first connection', async () => {
    const findOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated'))
      .mockResolvedValue({ id: 'user-1' })
    const { outcome, attempts, apiKeys, membership } = await connect(findOne)

    expect(outcome).toBe('connected')
    expect(findOne).toHaveBeenCalledTimes(2)
    expect(attempts).toHaveLength(2)
    expect(attempts[0].rooms.size).toBe(0)
    expect([...attempts[1].rooms]).toEqual(expect.arrayContaining(['user-1', 'org-1']))
    expect(apiKeys.validate).not.toHaveBeenCalled()
    expect(membership.exists).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('keeps unknown users and invalid credentials rejected (validToken=%s)', async (validToken) => {
    const findOne = jest.fn().mockResolvedValue(null)
    const { outcome, attempts, membership } = await connect(findOne, validToken)

    expect(outcome).toBe('refused')
    expect(client.active).toBe(false)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].rooms.size).toBe(0)
    expect(server.of('/').sockets.size).toBe(0)
    expect(membership.exists).not.toHaveBeenCalled()
    expect(findOne).toHaveBeenCalledTimes(validToken ? 1 : 0)
  })
})
