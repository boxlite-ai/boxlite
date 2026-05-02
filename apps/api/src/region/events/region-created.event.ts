/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { Region } from '../entities/region.entity'

export class RegionCreatedEvent {
  constructor(
    public readonly entityManager: EntityManager,
    public readonly region: Region,
    public readonly organizationId: string | null,
    public readonly snapshotManagerUsername?: string,
    public readonly snapshotManagerPassword?: string,
  ) {}
}
