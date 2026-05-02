/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SnapshotState } from '../../sandbox/enums/snapshot-state.enum'

export const SNAPSHOT_STATES_CONSUMING_RESOURCES: SnapshotState[] = [
  SnapshotState.BUILDING,
  SnapshotState.PENDING,
  SnapshotState.PULLING,
  SnapshotState.ACTIVE,
]
