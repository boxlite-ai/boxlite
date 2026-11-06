/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export class BoxliteError extends Error {
  public static fromError(error: Error, code?: string): BoxliteError {
    if (code === 'disposable_email' || code === 'email_required' || code === 'invalid_email') {
      return new RegistrationEmailError(error.message, code, { cause: error.cause })
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
