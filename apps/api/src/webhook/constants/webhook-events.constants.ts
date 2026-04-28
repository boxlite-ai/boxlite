/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum WebhookEvent {
  SANDBOX_CREATED = 'sandbox.created',
  SANDBOX_STATE_UPDATED = 'sandbox.state.updated',
  SNAPSHOT_CREATED = 'snapshot.created',
  SNAPSHOT_STATE_UPDATED = 'snapshot.state.updated',
  SNAPSHOT_REMOVED = 'snapshot.removed',
  VOLUME_CREATED = 'volume.created',
  VOLUME_STATE_UPDATED = 'volume.state.updated',
}
