/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @module Errors
 */

import type { AxiosHeaders } from 'axios'

type ResponseHeaders = InstanceType<typeof AxiosHeaders>

/**
 * Base error for BoxLite SDK.
 */
export class BoxliteError extends Error {
  /** HTTP status code if available */
  public statusCode?: number
  /** Response headers if available */
  public headers?: ResponseHeaders

  constructor(message: string, statusCode?: number, headers?: ResponseHeaders) {
    super(message)
    this.name = 'BoxliteError'
    this.statusCode = statusCode
    this.headers = headers
  }
}

export class BoxLiteNotFoundError extends BoxliteError {
  constructor(message: string, statusCode?: number, headers?: ResponseHeaders) {
    super(message, statusCode, headers)
    this.name = 'BoxLiteNotFoundError'
  }
}

/**
 * Error thrown when rate limit is exceeded.
 */
export class BoxLiteRateLimitError extends BoxliteError {
  constructor(message: string, statusCode?: number, headers?: ResponseHeaders) {
    super(message, statusCode, headers)
    this.name = 'BoxLiteRateLimitError'
  }
}

/**
 * Error thrown when a timeout occurs.
 */
export class BoxLiteTimeoutError extends BoxliteError {
  constructor(message: string, statusCode?: number, headers?: ResponseHeaders) {
    super(message, statusCode, headers)
    this.name = 'BoxLiteTimeoutError'
  }
}
