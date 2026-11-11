/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import * as jose from 'jose'
import { JwtStrategy } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'
import { LoginEventRecorder } from './login-event.recorder'
import { Context } from '../common/context/context'

const DEFAULT_REGION_ID = 'region-default-id'

function buildStrategy() {
  const createdUser = { id: 'user-1', role: 'user', email: 'new@boxlite.dev' }

  const userService = {
    findOne: jest.fn().mockResolvedValue(null), // new user → triggers create()
    create: jest.fn().mockResolvedValue(createdUser),
    update: jest.fn(),
  } as unknown as UserService

  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'defaultRegion.id') return DEFAULT_REGION_ID
      throw new Error(`unexpected config key: ${key}`)
    }),
  } as unknown as TypedConfigService

  const loginEvents = { recordFirstUse: jest.fn().mockResolvedValue(undefined) } as unknown as LoginEventRecorder

  const strategy = new JwtStrategy(
    { jwksUri: 'https://example.com/.well-known/jwks.json', audience: 'aud', issuer: 'iss' },
    userService,
    configService,
    loginEvents,
  )

  return { strategy, userService, loginEvents }
}

describe('JwtStrategy.validate — auto-created user', () => {
  it('anchors the Personal org to the default region for a new OIDC user', async () => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await strategy.validate(request, { sub: 'user-1', email: 'new@boxlite.dev', email_verified: true })

    // The bug: without defaultOrganizationDefaultRegionId, the downstream
    // UserCreatedEvent → handleUserCreatedEvent creates the default org with
    // defaultRegionId=undefined. Assert the strategy forwards the configured
    // region id into the create DTO.
    expect(userService.create).toHaveBeenCalledTimes(1)
    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({ defaultOrganizationDefaultRegionId: DEFAULT_REGION_ID }),
      expect.anything(),
    )
  })

  it('creates a first-login user as a registration by the user', async () => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await strategy.validate(request, { sub: 'user-1', email: 'new@boxlite.dev', email_verified: true })

    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      Context.user({ userId: 'user-1', authMethod: 'jwt' }),
    )
  })

  it('allows social identities through even when their provider claim is false', async () => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await strategy.validate(request, { sub: 'google-oauth2|user-1', email: 'new@boxlite.dev', email_verified: false })

    expect(userService.create).toHaveBeenCalledTimes(1)
  })

  it('hands the resolved user and the token claims to the login recorder', async () => {
    const { strategy, loginEvents } = buildStrategy()
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
      response: { code: 'email_required' },
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
