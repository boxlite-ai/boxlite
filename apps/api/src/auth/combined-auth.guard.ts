/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { EmailVerificationRequiredException } from '../exceptions/email-verification-required.exception'

/**
 * Main authentication guard for the application.
 *
 * Strategies are tried in array order.
 * On first success, the rest are skipped.
 *
 * `handleRequest` is invoked once — either when a strategy succeeds or when all strategies fail.
 * It returns the authenticated user object or throws a generic `UnauthorizedException`.
 *
 * The generic reply is deliberate: a caller must not learn which strategy rejected it or why,
 * so a wrong key and an unknown key are indistinguishable. A deliberate policy rejection is the
 * exception — it describes the authenticated caller's own account state, tells them nothing they
 * do not already know, and carries the status and machine code the client needs to act on.
 */
@Injectable()
export class CombinedAuthGuard extends AuthGuard(['api-key', 'jwt']) {
  private readonly logger = new Logger(CombinedAuthGuard.name)

  handleRequest(err: any, user: any) {
    // Flattening this to 401 would strip the status the client branches on and re-arm its
    // stale-token recovery, bouncing an unverified user through a login that cannot help.
    if (err instanceof EmailVerificationRequiredException) {
      throw err
    }

    if (err || !user) {
      this.logger.debug('Authentication failed', { err, user })
      throw new UnauthorizedException('Invalid credentials')
    }

    return user
  }
}
