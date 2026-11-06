/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { JwtStrategy } from './jwt.strategy'
import { EmailVerificationRequiredException } from '../exceptions/email-verification-required.exception'

const resource = 'https://api.example.test/api/mcp'

function setup(
  user: object | null = { id: 'auth0|existing', email: 'member@example.test', emailVerified: true, role: 'user' },
) {
  const users = {
    findOne: jest.fn().mockResolvedValue(user),
    create: jest.fn().mockResolvedValue({ id: 'social|missing', email: '', role: 'user' }),
    update: jest.fn(),
  }
  const logins = { recordFirstUse: jest.fn() }
  const strategy = new JwtStrategy(
    {
      jwksUri: 'https://issuer.example.test/jwks',
      issuer: 'https://issuer.example.test/',
      audience: 'rest',
      mcpAudience: resource,
    } as any,
    users as any,
    { getOrThrow: jest.fn() } as any,
    logins as any,
  )
  return { strategy, users, logins }
}

describe('MCP JWT identity on both resource interfaces', () => {
  it.each(['/api/mcp', '/api/v1/default/boxes'])(
    'accepts a claimless existing account on %s without rewriting it',
    async (path) => {
      const { strategy, users } = setup()
      const request = { path, get: jest.fn().mockReturnValue('caller-selected-org') } as unknown as Request
      await expect(strategy.validate(request, { sub: 'auth0|existing', aud: resource })).resolves.toMatchObject({
        userId: 'auth0|existing',
        email: 'member@example.test',
        mcp: true,
      })
      expect(users.create).not.toHaveBeenCalled()
      expect(users.update).not.toHaveBeenCalled()
      expect(request.get).not.toHaveBeenCalled()
    },
  )

  it('rejects a missing account without JIT registration', async () => {
    const { strategy, users } = setup(null)
    await expect(
      strategy.validate({ get: jest.fn() } as any, { sub: 'social|missing', aud: resource }),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    expect(users.create).not.toHaveBeenCalled()
  })

  it('uses persisted database-account verification even when the token says verified', async () => {
    const { strategy, users } = setup({ id: 'auth0|existing', emailVerified: false })
    await expect(
      strategy.validate({ get: jest.fn() } as any, { sub: 'auth0|existing', aud: resource, email_verified: true }),
    ).rejects.toBeInstanceOf(EmailVerificationRequiredException)
    expect(users.update).not.toHaveBeenCalled()
  })

  it('does not erase the email of a social account when identity claims are absent', async () => {
    const { strategy, users } = setup({ id: 'social|existing', email: 'member@example.test', role: 'user' })
    await strategy.validate({ get: jest.fn() } as any, { sub: 'social|existing', aud: ['other', resource] })
    expect(users.update).not.toHaveBeenCalled()
  })
})
