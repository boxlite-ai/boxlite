/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SavedImage } from '../entities/saved-image.entity'

export class SavedImageActivatedEvent {
  constructor(public readonly savedImage: SavedImage) {}
}
