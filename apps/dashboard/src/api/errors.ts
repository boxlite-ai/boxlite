/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Machine-readable rejection code carried in the API's error envelope (`code`,
 * shaped by apps/api/src/filters/all-exceptions.filter.ts). Branch on this
 * rather than on the human message, which is free to change. Must stay
 * byte-identical to EMAIL_VERIFICATION_REQUIRED_CODE in
 * apps/api/src/exceptions/email-verification-required.exception.ts.
 */
export const EMAIL_VERIFICATION_REQUIRED_CODE = 'email_verification_required'

export class BoxliteError extends Error {
  public static fromError(error: Error, code?: string): BoxliteError {
    if (code === EMAIL_VERIFICATION_REQUIRED_CODE) {
      return new EmailVerificationRequiredError(error.message, {
        cause: error.cause,
      })
    }

    if (String(error).includes('Organization is suspended')) {
      return new OrganizationSuspendedError(error.message, {
        cause: error.cause,
      })
    }

    return new BoxliteError(error.message, {
      cause: error.cause,
    })
  }

  public static fromString(error: string, options?: { cause?: Error; code?: string }): BoxliteError {
    return BoxliteError.fromError(new Error(error, { cause: options?.cause }), options?.code)
  }
}

export class OrganizationSuspendedError extends BoxliteError {}

/**
 * The API accepted the token and still refused the request: this identity has
 * not verified its email address. Distinct from an authentication failure —
 * signing in again cannot clear it, only verifying can, so the UI must offer
 * verification rather than another round trip through login.
 */
export class EmailVerificationRequiredError extends BoxliteError {}
