/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'

export class UserEmailVerifiedEvent {
  constructor(
    public readonly entityManager: EntityManager,
    public readonly userId: string,
  ) {}
}
