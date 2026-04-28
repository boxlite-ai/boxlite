/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

export class DefaultRegionRequiredException extends HttpException {
  constructor(
    message = 'This organization does not have a default region. Please open the BoxLite Dashboard to set a default region.',
  ) {
    super(message, HttpStatus.PRECONDITION_REQUIRED)
  }
}
