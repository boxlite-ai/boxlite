/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'

export class BoxConflictError extends ConflictException {
  constructor() {
    super('Box was modified by another operation')
  }
}
