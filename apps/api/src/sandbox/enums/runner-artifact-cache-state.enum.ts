/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum RunnerArtifactCacheState {
  PULLING_ARTIFACT = 'pulling_artifact',
  BUILDING_ARTIFACT = 'building_artifact',
  READY = 'ready',
  ERROR = 'error',
  REMOVING = 'removing',
}
