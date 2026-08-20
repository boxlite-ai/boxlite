/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { CombinedAuthGuard } from './combined-auth.guard'

describe('CombinedAuthGuard', () => {
  const guard = new CombinedAuthGuard()

  it('preserves an email-verification denial from the JWT strategy', () => {
    const denial = new ForbiddenException('Email verification required')

    expect(() => guard.handleRequest(denial, undefined)).toThrow(denial)
  })

  it('continues to hide ordinary authentication failures behind a generic 401', () => {
    expect(() => guard.handleRequest(new Error('signature details'), undefined)).toThrow(UnauthorizedException)
  })

  it('does not expose unrelated HTTP exceptions raised during authentication', () => {
    expect(() => guard.handleRequest(new BadRequestException('strategy details'), undefined)).toThrow(
      UnauthorizedException,
    )
  })
})
