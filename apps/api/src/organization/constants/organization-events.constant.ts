/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const OrganizationEvents = {
  INVITATION_CREATED: 'invitation.created',
  INVITATION_ACCEPTED: 'invitation.accepted',
  INVITATION_DECLINED: 'invitation.declined',
  INVITATION_CANCELLED: 'invitation.cancelled',
  CREATED: 'organization.created',
  SUSPENDED_BOX_STOPPED: 'organization.suspended-box-stopped',
  PERMISSIONS_UNASSIGNED: 'permissions.unassigned',
} as const
