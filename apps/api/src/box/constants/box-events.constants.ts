/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const BoxEvents = {
  ARCHIVED: 'box.archived',
  STATE_UPDATED: 'box.state.updated',
  DESIRED_STATE_UPDATED: 'box.desired-state.updated',
  CREATED: 'box.created',
  STARTED: 'box.started',
  STOPPED: 'box.stopped',
  DESTROYED: 'box.destroyed',
  PUBLIC_STATUS_UPDATED: 'box.public-status.updated',
  ORGANIZATION_UPDATED: 'box.organization.updated',
} as const
