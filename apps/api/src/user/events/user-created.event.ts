/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { User } from '../user.entity'

export class UserCreatedEvent {
  constructor(
    public readonly entityManager: EntityManager,
    public readonly user: User,
    public readonly defaultOrganizationDefaultRegionId?: string,
  ) {}
}
