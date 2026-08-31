/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

export const BOX_CREATION_LIMIT_EXCEEDED_CODE = 'resource_exhausted'
export const BOX_CREATION_ADMISSION_UNAVAILABLE_CODE = 'upstream_unavailable'

export class BoxCreationLimitExceededError extends HttpException {
  constructor(currentCount: number, limit: number) {
    super(
      {
        message: `Organization box creation limit reached: ${currentCount} of ${limit} boxes are already counted`,
        code: BOX_CREATION_LIMIT_EXCEEDED_CODE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
    this.name = 'BoxCreationLimitExceededError'
  }
}

export class BoxCreationAdmissionUnavailableError extends HttpException {
  constructor(message = 'Box creation admission is temporarily unavailable') {
    super({ message, code: BOX_CREATION_ADMISSION_UNAVAILABLE_CODE }, HttpStatus.SERVICE_UNAVAILABLE)
    this.name = 'BoxCreationAdmissionUnavailableError'
  }
}
