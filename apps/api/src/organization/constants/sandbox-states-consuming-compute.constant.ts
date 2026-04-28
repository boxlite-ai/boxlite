/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'

export const SANDBOX_STATES_CONSUMING_COMPUTE: SandboxState[] = [
  SandboxState.CREATING,
  SandboxState.RESTORING,
  SandboxState.STARTED,
  SandboxState.STARTING,
  SandboxState.STOPPING,
  SandboxState.PENDING_BUILD,
  SandboxState.BUILDING_SNAPSHOT,
  SandboxState.UNKNOWN,
  SandboxState.PULLING_SNAPSHOT,
]
