/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeState } from '../../sandbox/enums/volume-state.enum'

export const VOLUME_STATES_CONSUMING_RESOURCES: VolumeState[] = [
  VolumeState.CREATING,
  VolumeState.READY,
  VolumeState.PENDING_CREATE,
  VolumeState.PENDING_DELETE,
  VolumeState.DELETING,
]
