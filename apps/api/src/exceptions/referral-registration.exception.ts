/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

// Clients branch on the code, not the message, so each code is part of the API.
const REFERRAL_REGISTRATION_ERRORS = {
  invalid_referral_code: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Invalid referral code' },
  referral_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Referral codes cannot be checked right now; try again later',
  },
} as const

export type ReferralRegistrationErrorCode = keyof typeof REFERRAL_REGISTRATION_ERRORS

/**
 * Refuses the request that would have created an account from a referral code;
 * no account is created, so the client may retry, or retry without the code.
 *
 * Never 401: the token is valid, and the dashboard treats every 401 as a stale
 * token. The status follows from the code, so the two cannot disagree.
 */
export class ReferralRegistrationException extends HttpException {
  constructor(readonly code: ReferralRegistrationErrorCode) {
    super({ message: REFERRAL_REGISTRATION_ERRORS[code].message, code }, REFERRAL_REGISTRATION_ERRORS[code].status)
  }
}
