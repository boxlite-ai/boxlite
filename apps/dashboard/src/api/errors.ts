/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export class BoxliteError extends Error {
  public static fromError(error: Error): BoxliteError {
    if (String(error).includes('Organization is suspended')) {
      return new OrganizationSuspendedError(error.message, {
        cause: error.cause,
      })
    }

    return new BoxliteError(error.message, {
      cause: error.cause,
    })
  }

  public static fromString(error: string, options?: { cause?: Error }): BoxliteError {
    return BoxliteError.fromError(new Error(error, options))
  }
}

export class OrganizationSuspendedError extends BoxliteError {}
