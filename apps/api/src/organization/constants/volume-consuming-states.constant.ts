/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeState } from '../../box/enums/volume-state.enum'

/**
 * States in which a volume still occupies object storage and therefore counts
 * against the organization's volume quota. A volume on its way in or out is
 * counted — only DELETED (bucket contents gone) and ERROR (never materialized)
 * are free.
 */
export const VOLUME_STATES_CONSUMING_STORAGE: VolumeState[] = [
  VolumeState.CREATING,
  VolumeState.READY,
  VolumeState.PENDING_CREATE,
  VolumeState.PENDING_DELETE,
  VolumeState.DELETING,
]
