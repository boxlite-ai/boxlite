/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImageState } from '../../sandbox/enums/saved-image-state.enum'

export const SAVED_IMAGE_STATES_CONSUMING_RESOURCES: SavedImageState[] = [
  SavedImageState.BUILDING,
  SavedImageState.PENDING,
  SavedImageState.PULLING,
  SavedImageState.ACTIVE,
]
