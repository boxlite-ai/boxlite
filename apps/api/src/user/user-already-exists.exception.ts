/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'

export class UserAlreadyExistsException extends ConflictException {
  constructor(cause: unknown) {
    super({ message: 'User already exists', code: 'user_already_exists' }, { cause })
  }
}
