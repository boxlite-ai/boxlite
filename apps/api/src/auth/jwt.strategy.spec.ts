/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import * as jose from 'jose'
import { JwtStrategy } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { LoginEventRecorder } from './login-event.recorder'

function buildStrategy() {
  const createdUser = { id: 'user-1', role: 'user', email: 'new@boxlite.dev' }

  const userService = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(createdUser),
    update: jest.fn(),
  } as unknown as UserService

  const loginEvents = { recordFirstUse: jest.fn().mockResolvedValue(undefined) } as unknown as LoginEventRecorder

  const strategy = new JwtStrategy(
    { jwksUri: 'https://example.com/.well-known/jwks.json', audience: 'aud', issuer: 'iss' },
    userService,
    loginEvents,
  )

  return { strategy, userService, loginEvents }
}

describe('JwtStrategy.validate — local account access', () => {
  it.each([undefined, '', '   ', 42])(
    'rejects an unusable identity before accessing local accounts (%s)',
    async (sub) => {
      const { strategy, userService, loginEvents } = buildStrategy()
      const request = { get: jest.fn() } as unknown as Request

      await expect(strategy.validate(request, { sub })).rejects.toMatchObject({ status: 401 })

      expect(userService.findOne).not.toHaveBeenCalled()
      expect(userService.create).not.toHaveBeenCalled()
      expect(userService.update).not.toHaveBeenCalled()
      expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
    },
  )

  it('hands the resolved user and the token claims to the login recorder', async () => {
    const { strategy, userService, loginEvents } = buildStrategy()
    jest
      .mocked(userService.findOne)
      .mockResolvedValue({ id: 'user-1', name: 'Existing', email: 'new@boxlite.dev', emailVerified: true } as never)
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request
    const payload = { sub: 'user-1', email: 'new@boxlite.dev', email_verified: true, iat: 1000, exp: 4600 }

    await strategy.validate(request, payload)

    expect(loginEvents.recordFirstUse).toHaveBeenCalledWith('user-1', payload)
  })

  it.each([undefined, '', '   '])('rejects a new OIDC user without a registration email (%s)', async (email) => {
    const { strategy, userService, loginEvents } = buildStrategy()
    const request = { get: jest.fn() } as unknown as Request

    await expect(strategy.validate(request, { sub: 'github|new-user', email })).rejects.toMatchObject({
      status: 403,
      response: { code: 'registration_required' },
    })

    expect(userService.create).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })

  it('allows an existing user whose email domain is now disposable', async () => {
    const { strategy, userService, loginEvents } = buildStrategy()
    const user = { id: 'auth0|existing', name: 'Existing User', email: 'existing@mailinator.com', emailVerified: true }
    jest.mocked(userService.findOne).mockResolvedValue(user as never)
    const request = { get: jest.fn() } as unknown as Request

    await expect(
      strategy.validate(request, { sub: user.id, email: user.email, email_verified: true }),
    ).resolves.toMatchObject({ userId: user.id, email: user.email })

    expect(userService.create).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).toHaveBeenCalledTimes(1)
  })

  it('preserves an existing OIDC user login without an email claim', async () => {
    const { strategy, userService, loginEvents } = buildStrategy()
    const user = { id: 'github|existing', name: 'Existing User', email: '', emailVerified: false }
    jest.mocked(userService.findOne).mockResolvedValue(user as never)
    const request = { get: jest.fn() } as unknown as Request

    await expect(strategy.validate(request, { sub: user.id })).resolves.toMatchObject({ userId: user.id })

    expect(userService.create).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).toHaveBeenCalledTimes(1)
  })

  // Third-party MCP clients get access tokens without profile claims (#2404).
  it('keeps a known user email and name when the token carries neither', async () => {
    const { strategy, userService } = buildStrategy()
    const user = {
      id: 'google-oauth2|existing',
      name: 'Existing User',
      email: 'existing@gmail.com',
      emailVerified: true,
    }
    jest.mocked(userService.findOne).mockResolvedValue(user as never)
    const request = { get: jest.fn() } as unknown as Request

    await expect(strategy.validate(request, { sub: user.id })).resolves.toMatchObject({
      userId: user.id,
      email: user.email,
    })

    expect(userService.update).not.toHaveBeenCalled()
  })

  // The login Action is the only email-verification gate; the API trusts the
  // tokens it lets through, whether or not they carry `email_verified`.
  it('admits a known database user whose MCP token carries no email_verified', async () => {
    const { strategy, userService } = buildStrategy()
    const user = { id: 'auth0|existing', name: 'Existing User', email: 'existing@boxlite.dev', emailVerified: true }
    jest.mocked(userService.findOne).mockResolvedValue(user as never)
    const request = { get: jest.fn() } as unknown as Request

    await expect(strategy.validate(request, { sub: user.id })).resolves.toMatchObject({ userId: user.id })

    expect(userService.update).not.toHaveBeenCalled()
  })

  it('preserves an existing user login when the provider updates their email to a disposable domain', async () => {
    const { strategy, userService, loginEvents } = buildStrategy()
    const user = { id: 'github|existing', name: 'Existing User', email: 'existing@gmail.com', emailVerified: true }
    jest.mocked(userService.findOne).mockResolvedValue(user as never)
    const request = { get: jest.fn() } as unknown as Request

    await strategy.validate(request, { sub: user.id, email: 'existing@mailinator.com', email_verified: true })

    expect(userService.create).not.toHaveBeenCalled()
    expect(userService.update).toHaveBeenCalledWith(user.id, { email: 'existing@mailinator.com' })
    expect(loginEvents.recordFirstUse).toHaveBeenCalledTimes(1)
  })
})

describe('JwtStrategy.verifyToken', () => {
  afterEach(() => jest.restoreAllMocks())

  it('returns the payload of a token without profile claims', async () => {
    const { strategy } = buildStrategy()
    const payload = { sub: 'auth0|123' }
    jest.spyOn(jose, 'jwtVerify').mockResolvedValue({
      payload,
      protectedHeader: { alg: 'RS256' },
    } as any)

    await expect(strategy.verifyToken('verified-token')).resolves.toMatchObject(payload)
  })
})
