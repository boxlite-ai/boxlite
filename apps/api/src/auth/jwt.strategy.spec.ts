/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { HttpStatus, UnauthorizedException } from '@nestjs/common'
import * as jose from 'jose'
import { JwtStrategy, requireVerifiedAuth0DatabaseEmail } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'
import { LoginEventRecorder } from './login-event.recorder'
import { Context } from '../common/context/context'
import {
  EMAIL_VERIFICATION_REQUIRED_CODE,
  EmailVerificationRequiredException,
} from '../exceptions/email-verification-required.exception'

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

    expect(userService.create).toHaveBeenCalledWith(expect.anything(), Context.user())
  })

  it('rejects an unverified Auth0 database identity before local user creation', async () => {
    const { strategy, userService } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await expect(
      strategy.validate(request, { sub: 'auth0|user-1', email: 'new@boxlite.dev', email_verified: false }),
    ).rejects.toThrow(EmailVerificationRequiredException)
    expect(userService.findOne).not.toHaveBeenCalled()
    expect(userService.create).not.toHaveBeenCalled()
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

  // A rejected token is not a login, so nothing may be recorded for it.
  it('does not record a login for a rejected unverified identity', async () => {
    const { strategy, loginEvents } = buildStrategy()
    const request = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request

    await expect(
      strategy.validate(request, { sub: 'auth0|user-1', email: 'new@boxlite.dev', email_verified: false }),
    ).rejects.toThrow(EmailVerificationRequiredException)
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })
})

describe('requireVerifiedAuth0DatabaseEmail', () => {
  it('rejects false or missing verification on Auth0 database identities', () => {
    expect(() => requireVerifiedAuth0DatabaseEmail({ sub: 'auth0|123', email_verified: false })).toThrow(
      EmailVerificationRequiredException,
    )
    expect(() => requireVerifiedAuth0DatabaseEmail({ sub: 'auth0|123' })).toThrow(EmailVerificationRequiredException)
  })

  // 401 would tell the dashboard the token is stale, which re-arms a re-login
  // loop that cannot clear an unverified address. 403 says the token is fine
  // and the bearer is not yet allowed — the client can then show a real screen.
  it('rejects with 403 and a machine-readable code, never 401', () => {
    let thrown: unknown
    try {
      requireVerifiedAuth0DatabaseEmail({ sub: 'auth0|123', email_verified: false })
    } catch (error) {
      thrown = error
    }

    const exception = thrown as EmailVerificationRequiredException
    expect(exception).toBeInstanceOf(EmailVerificationRequiredException)
    expect(exception.getStatus()).toBe(HttpStatus.FORBIDDEN)
    expect(exception.getResponse()).toMatchObject({ code: 'email_verification_required' })

    // Pinned to the literal, not the constant: asserting the constant against
    // itself proves nothing, and the dashboard keeps its own copy of this string
    // (apps/dashboard/src/api/errors.ts). A rename on either side must break a
    // test rather than silently desync the wire contract.
    expect(EMAIL_VERIFICATION_REQUIRED_CODE).toBe('email_verification_required')
  })

  it('accepts verified Auth0 database and non-Auth0 identities', () => {
    expect(() => requireVerifiedAuth0DatabaseEmail({ sub: 'auth0|123', email_verified: true })).not.toThrow()
    expect(() => requireVerifiedAuth0DatabaseEmail({ sub: 'google-oauth2|123', email_verified: false })).not.toThrow()
  })
})

describe('JwtStrategy.verifyToken', () => {
  afterEach(() => jest.restoreAllMocks())

  it('applies the same email-verification gate to direct JWT consumers', async () => {
    const { strategy } = buildStrategy()
    jest.spyOn(jose, 'jwtVerify').mockResolvedValue({
      payload: { sub: 'auth0|123', email_verified: false },
      protectedHeader: { alg: 'RS256' },
    } as any)

    await expect(strategy.verifyToken('already-issued-token')).rejects.toThrow(EmailVerificationRequiredException)
  })

  it('returns a verified Auth0 database payload', async () => {
    const { strategy } = buildStrategy()
    const payload = { sub: 'auth0|123', email_verified: true }
    jest.spyOn(jose, 'jwtVerify').mockResolvedValue({
      payload,
      protectedHeader: { alg: 'RS256' },
    } as any)

    await expect(strategy.verifyToken('verified-token')).resolves.toMatchObject(payload)
  })
})

// Pinned to the literals the Auth0 Action writes (apps/infra/bootstrap/auth0/login-policy.js),
// so a rename on either side breaks a test.
const EMAIL_VERIFIED_CLAIM = 'https://boxlite.ai/claims/email_verified'
const EMAIL_CLAIM = 'https://boxlite.ai/claims/email'
const NAME_CLAIM = 'https://boxlite.ai/claims/name'

describe('JwtStrategy namespaced identity claims', () => {
  afterEach(() => jest.restoreAllMocks())

  const request = () => ({ get: jest.fn().mockReturnValue(undefined) }) as unknown as Request

  it('admits a verified Auth0 database identity that carries only namespaced claims', async () => {
    const { strategy } = buildStrategy()
    jest.spyOn(jose, 'jwtVerify').mockResolvedValue({
      payload: { sub: 'auth0|123', [EMAIL_VERIFIED_CLAIM]: true },
      protectedHeader: { alg: 'RS256' },
    } as any)

    await expect(strategy.verifyToken('mcp-token')).resolves.toMatchObject({ sub: 'auth0|123', email_verified: true })
  })

  it('creates the user from namespaced email, name, and verification', async () => {
    const { strategy, userService } = buildStrategy()

    await strategy.validate(request(), {
      sub: 'auth0|123',
      [EMAIL_VERIFIED_CLAIM]: true,
      [EMAIL_CLAIM]: 'new@boxlite.dev',
      [NAME_CLAIM]: 'New Person',
    })

    expect(userService.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auth0|123', email: 'new@boxlite.dev', name: 'New Person', emailVerified: true }),
      expect.anything(),
    )
  })

  it.each([false, null, 'true', 1])(
    'rejects namespaced verification %p even when the plain claim says true',
    async (namespaced) => {
      const { strategy, userService } = buildStrategy()
      const payload = { sub: 'auth0|123', email_verified: true, [EMAIL_VERIFIED_CLAIM]: namespaced }
      jest.spyOn(jose, 'jwtVerify').mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } } as any)

      await expect(strategy.verifyToken('mcp-token')).rejects.toThrow(EmailVerificationRequiredException)
      await expect(strategy.validate(request(), payload)).rejects.toThrow(EmailVerificationRequiredException)
      expect(userService.findOne).not.toHaveBeenCalled()
    },
  )

  it.each([
    [EMAIL_CLAIM, 42],
    [NAME_CLAIM, { first: 'New' }],
  ])('rejects a non-string %s before touching local users', async (claim, value) => {
    const { strategy, userService } = buildStrategy()

    await expect(
      strategy.validate(request(), { sub: 'auth0|123', [EMAIL_VERIFIED_CLAIM]: true, [claim]: value }),
    ).rejects.toThrow(UnauthorizedException)
    expect(userService.findOne).not.toHaveBeenCalled()
    expect(userService.create).not.toHaveBeenCalled()
  })

  it('does not change the verified payload it was handed', async () => {
    const { strategy } = buildStrategy()
    const payload = { sub: 'auth0|123', [EMAIL_VERIFIED_CLAIM]: true, [EMAIL_CLAIM]: 'new@boxlite.dev' }
    jest.spyOn(jose, 'jwtVerify').mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } } as any)

    await strategy.verifyToken('mcp-token')
    await strategy.validate(request(), payload)

    expect(payload).toEqual({ sub: 'auth0|123', [EMAIL_VERIFIED_CLAIM]: true, [EMAIL_CLAIM]: 'new@boxlite.dev' })
  })
})
