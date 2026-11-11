/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { JwtStrategy } from './jwt.strategy'
import { CombinedAuthGuard } from './combined-auth.guard'
import { NotificationGateway } from '../notification/gateways/notification.gateway'

describe('Registration access boundary', () => {
  it('rejects an unknown JWT identity without creating a user', async () => {
    const users = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'new-user' }),
    }
    const strategy = new JwtStrategy(
      { issuer: 'https://issuer.test', audience: 'api', jwksUri: 'https://issuer.test/jwks' },
      users as never,
      { get: () => ({ sitekey: 'configured' }) } as never,
      { recordFirstUse: jest.fn() } as never,
    )
    await expect(
      strategy.validate({ get: jest.fn() } as never, { sub: 'new-user', email: 'new@example.com' }),
    ).rejects.toMatchObject({ status: 403, response: { code: 'registration_required' } })
    expect(users.create).not.toHaveBeenCalled()
  })

  it('preserves the registration-required status through the combined guard', () => {
    const error = new ForbiddenException({
      code: 'registration_required',
      message: 'Complete registration to continue',
    })
    expect(() => new CombinedAuthGuard().handleRequest(error, false)).toThrow(error)
  })

  it('rejects an unknown notification identity before joining any room', async () => {
    const gateway = Reflect.construct(NotificationGateway, [
      { verifyToken: jest.fn().mockResolvedValue({ sub: 'new-user' }) },
      { validate: jest.fn().mockResolvedValue(null) },
      { exists: jest.fn() },
      {},
      { findOne: jest.fn().mockResolvedValue(null) },
    ]) as NotificationGateway
    let connect: (socket: unknown, next: unknown) => Promise<void>
    gateway.afterInit({
      use: (middleware: typeof connect) => {
        connect = middleware
      },
    } as never)
    const join = jest.fn()
    const next = jest.fn()
    await connect({ handshake: { auth: { token: 'token' }, query: {} }, join }, next)
    expect(join).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
  })
})
