/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * Machine-readable discriminator for this rejection. The dashboard branches on
 * it rather than on the human message — see EMAIL_VERIFICATION_REQUIRED_CODE in
 * apps/dashboard/src/api/errors.ts, which must stay byte-identical.
 */
export const EMAIL_VERIFICATION_REQUIRED_CODE = 'email_verification_required'

/**
 * The caller's token is valid — signature, audience, issuer and expiry all
 * check out — but the identity behind it has not verified its email address.
 *
 * 403, not 401: RFC 6750 section 3.1 reserves 401 `invalid_token` for a token
 * the resource server cannot accept, and 403 for a good token whose bearer
 * lacks the privilege. The distinction is load-bearing here — the dashboard
 * treats every 401 as a stale token and bounces to a fresh login, a recovery
 * that can never clear a rejection which survives re-authentication.
 */
export class EmailVerificationRequiredException extends HttpException {
  constructor() {
    super({ message: 'Email verification required', code: EMAIL_VERIFICATION_REQUIRED_CODE }, HttpStatus.FORBIDDEN)
  }
}
