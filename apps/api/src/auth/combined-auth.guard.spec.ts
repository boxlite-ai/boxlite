/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, UnauthorizedException } from '@nestjs/common'
import { CombinedAuthGuard } from './combined-auth.guard'
import {
  EMAIL_VERIFICATION_REQUIRED_CODE,
  EmailVerificationRequiredException,
} from '../exceptions/email-verification-required.exception'

describe('CombinedAuthGuard.handleRequest', () => {
  it('delivers an email-verification rejection to the client intact', () => {
    const guard = new CombinedAuthGuard()
    const rejection = new EmailVerificationRequiredException()

    let thrown: unknown
    try {
      guard.handleRequest(rejection, false)
    } catch (error) {
      thrown = error
    }

    // Same instance, so the status and code JwtStrategy chose survive the guard.
    // Flattening it to 401 tells the dashboard the token is stale and re-arms a
    // re-login loop that cannot clear an unverified address.
    expect(thrown).toBe(rejection)
    expect((thrown as EmailVerificationRequiredException).getStatus()).toBe(HttpStatus.FORBIDDEN)
    expect((thrown as EmailVerificationRequiredException).getResponse()).toMatchObject({
      code: 'email_verification_required',
    })
    // Pinned to the literal, not the constant: asserting the constant against
    // itself proves nothing, and the dashboard keeps its own copy of this string
    // (apps/dashboard/src/api/errors.ts). A rename on either side must break a
    // test rather than silently desync the wire contract.
    expect(EMAIL_VERIFICATION_REQUIRED_CODE).toBe('email_verification_required')
  })

  it('still flattens an ordinary strategy failure to a generic 401', () => {
    const guard = new CombinedAuthGuard()

    // A caller must not learn which strategy rejected it: a wrong key and an
    // unknown key have to look identical.
    expect(() => guard.handleRequest(new Error('jwt malformed'), false)).toThrow(UnauthorizedException)
    expect(() => guard.handleRequest(new Error('jwt malformed'), false)).toThrow('Invalid credentials')
  })

  it('still rejects when no strategy produced a user', () => {
    const guard = new CombinedAuthGuard()

    expect(() => guard.handleRequest(null, false)).toThrow(UnauthorizedException)
  })

  it('returns the authenticated user on success', () => {
    const guard = new CombinedAuthGuard()
    const user = { userId: 'user-1' }

    expect(guard.handleRequest(null, user)).toBe(user)
  })
})
