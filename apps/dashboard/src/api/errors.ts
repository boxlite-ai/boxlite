/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type BoxliteErrorOptions = ErrorOptions & {
  code?: string
  retryAfterSeconds?: number
  statusCode?: number
  boxId?: string
}

export class BoxliteError extends Error {
  public readonly code?: string
  public readonly retryAfterSeconds?: number
  public readonly statusCode?: number
  public readonly boxId?: string

  constructor(message: string, options: BoxliteErrorOptions = {}) {
    super(message, options)
    this.code = options.code
    this.retryAfterSeconds = options.retryAfterSeconds
    this.statusCode = options.statusCode
    this.boxId = options.boxId
  }

  public static fromError(error: Error, options: BoxliteErrorOptions = {}): BoxliteError {
    const { code, retryAfterSeconds } = options
    if (code === 'disposable_email' || code === 'email_required' || code === 'invalid_email') {
      return new RegistrationEmailError(error.message, code, { cause: error.cause })
    }

    if (code && registrationCodes.includes(code)) {
      return new RegistrationError(error.message, code, retryAfterSeconds, { cause: error.cause })
    }

    if (String(error).includes('Organization is suspended')) {
      return new OrganizationSuspendedError(error.message, {
        cause: error.cause,
      })
    }

    return new BoxliteError(error.message, options)
  }

  public static fromString(error: string, options: BoxliteErrorOptions = {}): BoxliteError {
    return BoxliteError.fromError(new Error(error, { cause: options.cause }), options)
  }
}

export class OrganizationSuspendedError extends BoxliteError {}

const registrationCodes = [
  'registration_required',
  'turnstile_token_required',
  'turnstile_token_invalid',
  'turnstile_verification_failed',
  'turnstile_unavailable',
  'registration_rate_limited',
  'registration_rate_limit_unavailable',
]

export class RegistrationError extends BoxliteError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** The identity is authenticated, but its email cannot be used to create a BoxLite account. */
export class RegistrationEmailError extends BoxliteError {
  constructor(
    message: string,
    public readonly code: 'disposable_email' | 'email_required' | 'invalid_email',
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
