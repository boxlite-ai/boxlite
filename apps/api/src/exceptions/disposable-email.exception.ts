/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

/** Rejects registration without invalidating the caller's authentication. */
export class DisposableEmailException extends HttpException {
  constructor() {
    super(
      { message: 'Disposable email addresses are not supported for registration', code: 'disposable_email' },
      HttpStatus.FORBIDDEN,
    )
  }
}
