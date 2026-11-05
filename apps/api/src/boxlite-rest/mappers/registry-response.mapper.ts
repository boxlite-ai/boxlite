/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { RegistryCredential } from '../../registry/entities/registry-credential.entity'

export function toRestCredential(credential: RegistryCredential) {
  return {
    id: credential.id,
    registry_host: credential.registryHost,
    repository_prefix: credential.repositoryPrefix,
    username: credential.username,
    created_by: credential.createdBy,
    created_at: credential.createdAt.toISOString(),
  }
}
