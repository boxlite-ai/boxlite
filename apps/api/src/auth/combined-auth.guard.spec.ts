/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, UnauthorizedException } from '@nestjs/common'
import { CombinedAuthGuard } from './combined-auth.guard'

import { ReferralRegistrationException } from '../exceptions/referral-registration.exception'

describe('CombinedAuthGuard.handleRequest', () => {
  // Codes pinned as literals: clients branch on these exact strings.
  it.each([
    ['invalid_referral_code', HttpStatus.UNPROCESSABLE_ENTITY],
    ['referral_unavailable', HttpStatus.SERVICE_UNAVAILABLE],
  ] as const)('delivers a %s referral rejection to the client intact', (code, status) => {
    const guard = new CombinedAuthGuard()
    const rejection = new ReferralRegistrationException(code)

    let thrown: unknown
    try {
      guard.handleRequest(rejection, false)
    } catch (error) {
      thrown = error
    }

    // A 401 would send the invitee through a login that cannot help, and count
    // against their failed-authentication budget.
    expect(thrown).toBe(rejection)
    expect((thrown as ReferralRegistrationException).getStatus()).toBe(status)
    expect((thrown as ReferralRegistrationException).getResponse()).toMatchObject({ code })
  })

  it('flattens an ordinary strategy failure to a generic 401', () => {
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
