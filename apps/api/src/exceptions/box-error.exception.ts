/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * A box-lifecycle guard rejected the request.
 *
 * Carries a machine-readable `code` because the SDKs dispatch on it: without
 * one, `AllExceptionsFilter` emits the flat envelope with no `code`, and the
 * client can only guess from the status. That guess used to be
 * `BoxliteError::Internal`, which reads to the user as a server crash and is
 * invisible to retry logic keyed on typed variants — a transient
 * "State change in progress" is exactly the case worth retrying.
 *
 * Defaults to `invalid_state` since every current caller is a state-machine
 * guard; pass an explicit code for anything else.
 */
export class BoxError extends HttpException {
  constructor(message: string, code = 'invalid_state') {
    super({ message, code }, HttpStatus.BAD_REQUEST)
  }
}
