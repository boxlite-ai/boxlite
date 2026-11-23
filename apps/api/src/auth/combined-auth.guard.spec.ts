/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UnauthorizedException } from '@nestjs/common'
import { CombinedAuthGuard } from './combined-auth.guard'

describe('CombinedAuthGuard.handleRequest', () => {
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
