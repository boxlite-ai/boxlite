/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { isCuratedSelector } from '../../image/utils/image-ref.util'

/**
 * Whether a box's image belongs to its organization rather than to the
 * operator's curated set.
 *
 * Asked when a box reports what its image resolved to, to decide whether the
 * image goes into the organization's catalog or is pinned as a curated image,
 * and when a box is dispatched, to decide whether a curated tag is handed over
 * pinned to this runner's build. Recomputing it from `box.image`
 * against the curated set as it stands at that moment would ask the wrong set —
 * an operator rotating a curated reference makes every box still running the
 * old one look tenant-owned — so the answer recorded at create is read back.
 *
 * A row written before the column exists has nothing recorded, and recomputing
 * is the best answer there is for it. That is the old behaviour, kept exactly,
 * for exactly the rows that cannot have anything better.
 */
export function boxImageIsOrgOwned(box: Pick<Box, 'image' | 'imageIsOrgOwned'>): boolean {
  return box.imageIsOrgOwned ?? !isCuratedSelector(box.image)
}
