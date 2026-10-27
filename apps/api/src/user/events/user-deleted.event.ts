/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { TransactionalEvent } from '../../common/events/transactional.event'

export class UserDeletedEvent extends TransactionalEvent {
  constructor(
    entityManager: EntityManager,
    public readonly userId: string,
  ) {
    super(entityManager)
  }
}
