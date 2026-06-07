/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { Region } from '../entities/region.entity'

export class RegionArtifactRegistryCredsRegeneratedEvent {
  constructor(
    public readonly regionId: string,
    public readonly artifactRegistryUrl: string,
    public readonly username: string,
    public readonly password: string,
    public readonly entityManager?: EntityManager,
  ) {}
}

export class RegionArtifactRegistryUpdatedEvent {
  constructor(
    public readonly region: Region,
    public readonly organizationId: string,
    public readonly artifactRegistryUrl: string | null,
    public readonly prevArtifactRegistryUrl: string | null,
    public readonly newUsername?: string,
    public readonly newPassword?: string,
    public readonly entityManager?: EntityManager,
  ) {}
}
