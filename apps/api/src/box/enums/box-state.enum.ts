/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum BoxState {
  CREATING = 'creating',
  RESTORING = 'restoring',
  DESTROYED = 'destroyed',
  DESTROYING = 'destroying',
  STARTED = 'started',
  STOPPED = 'stopped',
  STARTING = 'starting',
  STOPPING = 'stopping',
  ERROR = 'error',
  UNKNOWN = 'unknown',
  PULLING_ARTIFACT = 'pulling_artifact',
  ARCHIVED = 'archived',
  ARCHIVING = 'archiving',
  RESIZING = 'resizing',
}
