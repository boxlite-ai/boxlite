/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException } from '@nestjs/common'
import { AcceptedLegalVersions } from '../user/registration-consent.entity'

export function registrationConsent(body: unknown, current: AcceptedLegalVersions): AcceptedLegalVersions {
  const request = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (request.accepted !== true) {
    throw new BadRequestException({ code: 'consent_required', message: 'Accept the terms to continue registration' })
  }
  if (request.tosVersion !== current.tosVersion || request.privacyVersion !== current.privacyVersion) {
    throw new ConflictException({ code: 'legal_version_mismatch', message: 'Review the current terms and try again' })
  }
  return { tosVersion: current.tosVersion, privacyVersion: current.privacyVersion }
}

export function registrationToken(body: unknown): string {
  const token = body && typeof body === 'object' ? (body as Record<string, unknown>).turnstileToken : undefined
  if (token === undefined) {
    throw new BadRequestException({
      code: 'turnstile_token_required',
      message: 'Complete the verification to continue',
    })
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
    throw new BadRequestException({ code: 'turnstile_token_invalid', message: 'Invalid verification token' })
  }
  return token
}
