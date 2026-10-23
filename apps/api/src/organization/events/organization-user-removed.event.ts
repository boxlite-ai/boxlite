/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { TransactionalEvent } from '../../common/events/transactional.event'

export class OrganizationUserRemovedEvent extends TransactionalEvent {
  constructor(
    entityManager: EntityManager,
    public readonly organizationId: string,
    public readonly userId: string,
  ) {
    super(entityManager)
  }
}
