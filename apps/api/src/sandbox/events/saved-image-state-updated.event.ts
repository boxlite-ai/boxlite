/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'

export class SavedImageStateUpdatedEvent {
  constructor(
    public readonly savedImage: SavedImage,
    public readonly oldState: SavedImageState,
    public readonly newState: SavedImageState,
  ) {}
}
