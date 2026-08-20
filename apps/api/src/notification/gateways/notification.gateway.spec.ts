/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotificationGateway } from './notification.gateway'

describe('NotificationGateway authentication', () => {
  it('uses the verified-email JWT path before joining notification rooms', async () => {
    const jwtStrategy = {
      verifyVerifiedToken: jest.fn().mockResolvedValue({ sub: 'user-1', email_verified: true }),
    }
    const apiKeyStrategy = { validate: jest.fn() }
    const gateway = new NotificationGateway(jwtStrategy as never, apiKeyStrategy as never, {} as never)
    const server = { use: jest.fn() }
    gateway.afterInit(server as never)

    const middleware = server.use.mock.calls[0][0]
    const socket = {
      handshake: { auth: { token: 'signed-jwt' }, query: { organizationId: 'org-1' } },
      join: jest.fn().mockResolvedValue(undefined),
    }
    const next = jest.fn()

    await middleware(socket, next)

    expect(jwtStrategy.verifyVerifiedToken).toHaveBeenCalledWith('signed-jwt')
    expect(socket.join).toHaveBeenCalledWith('user-1')
    expect(socket.join).toHaveBeenCalledWith('org-1')
    expect(next).toHaveBeenCalledWith()
    expect(apiKeyStrategy.validate).not.toHaveBeenCalled()
  })
})
