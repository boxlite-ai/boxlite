/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

import { Logger } from '@nestjs/common'
import type { Server, Socket } from 'socket.io'
import { NotificationGateway } from './notification.gateway'
import { NotificationService } from '../services/notification.service'
import { OrganizationUserRemovedEvent } from '../../organization/events/organization-user-removed.event'
import { SystemRole } from '../../user/enums/system-role.enum'

type Middleware = (socket: Socket, next: (error?: Error) => void) => Promise<void>

function connect(options: {
  jwtPayload?: Record<string, unknown>
  apiKeyContext?: Record<string, unknown>
  queryOrganizationId?: string
  memberships: Array<[string, string]>
}) {
  const organizationUserService = {
    exists: jest.fn(async (organizationId: string, userId: string) =>
      options.memberships.some(([org, user]) => org === organizationId && user === userId),
    ),
  }
  const jwtStrategy = {
    verifyToken: jest.fn(async () => {
      if (!options.jwtPayload) throw new Error('not a JWT')
      return options.jwtPayload
    }),
  }
  const apiKeyStrategy = { validate: jest.fn(async () => options.apiKeyContext ?? null) }
  const gateway = new NotificationGateway(
    jwtStrategy as never,
    apiKeyStrategy as never,
    organizationUserService as never,
    {} as never,
  )

  let middleware: Middleware | undefined
  gateway.afterInit({ use: (fn: Middleware) => (middleware = fn) } as unknown as Server)

  const joined: string[] = []
  const socket = {
    handshake: { auth: { token: 'token' }, query: { organizationId: options.queryOrganizationId } },
    join: jest.fn(async (room: string) => {
      joined.push(room)
    }),
  } as unknown as Socket
  const next = jest.fn()
  const run = () => {
    if (!middleware) throw new Error('afterInit did not register the connection middleware')
    return middleware(socket, next)
  }
  return { run, joined, next }
}

describe('NotificationGateway connection rooms', () => {
  it('does not put a JWT user into an organization room they are not a member of', async () => {
    const socket = connect({ jwtPayload: { sub: 'user-2' }, queryOrganizationId: 'org-1', memberships: [] })

    await socket.run()

    expect(socket.joined).toEqual(['user-2'])
    expect(socket.next).toHaveBeenCalledWith()
  })

  it('puts a JWT member into the organization room they asked for', async () => {
    const socket = connect({
      jwtPayload: { sub: 'user-1' },
      queryOrganizationId: 'org-1',
      memberships: [['org-1', 'user-1']],
    })

    await socket.run()

    expect(socket.joined).toEqual(['user-1', 'org-1'])
  })

  it("checks an OKTA token's uid, not its sub, against the membership", async () => {
    const socket = connect({
      jwtPayload: { sub: 'user@example.com', cid: 'client', uid: 'user-1' },
      queryOrganizationId: 'org-1',
      memberships: [['org-1', 'user-1']],
    })

    await socket.run()

    expect(socket.joined).toEqual(['user-1', 'org-1'])
  })

  it("does not put an API key into its organization's room once its user is no longer a member", async () => {
    const socket = connect({
      apiKeyContext: { userId: 'user-2', role: SystemRole.USER, email: 'u@example.com', organizationId: 'org-1' },
      memberships: [],
    })

    await socket.run()

    expect(socket.joined).toEqual(['user-2'])
  })
})

describe('NotificationService on member removal', () => {
  it("takes the removed user's sockets out of the organization room only after the removal commits", async () => {
    const notificationEmitter = { leaveOrganizationRoom: jest.fn() }
    const service = new NotificationService(notificationEmitter as never, {} as never, {} as never, {} as never)
    const event = new OrganizationUserRemovedEvent({} as never, 'org-1', 'user-2')

    await service.handleOrganizationUserRemoved(event)
    expect(notificationEmitter.leaveOrganizationRoom).not.toHaveBeenCalled()

    await event.runAfterCommitTasks()
    expect(notificationEmitter.leaveOrganizationRoom).toHaveBeenCalledWith('user-2', 'org-1')
  })

  // The removal has already committed, so a failed eviction must not fail the request.
  it('does not fail the removal when the eviction throws', async () => {
    const notificationEmitter = {
      leaveOrganizationRoom: jest.fn(() => {
        throw new Error('redis unavailable')
      }),
    }
    const service = new NotificationService(notificationEmitter as never, {} as never, {} as never, {} as never)
    const event = new OrganizationUserRemovedEvent({} as never, 'org-1', 'user-2')
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    await service.handleOrganizationUserRemoved(event)

    await expect(event.runAfterCommitTasks()).resolves.toBeUndefined()
    expect(notificationEmitter.leaveOrganizationRoom).toHaveBeenCalledWith('user-2', 'org-1')
  })
})
