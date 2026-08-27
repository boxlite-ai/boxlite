/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { HttpStatus } from '@nestjs/common'
import * as jose from 'jose'
import { JwtStrategy, requireVerifiedAuth0DatabaseEmail } from './jwt.strategy'
import { UserService } from '../user/user.service'
import { TypedConfigService } from '../config/typed-config.service'
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

  const strategy = new JwtStrategy(
    { jwksUri: 'https://example.com/.well-known/jwks.json', audience: 'aud', issuer: 'iss' },
    userService,
    configService,
  )

  return { strategy, userService }
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
    )
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
