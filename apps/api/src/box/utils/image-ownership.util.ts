/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { isCuratedSelector, isDigestPinned } from '../../image/utils/image-ref.util'

/**
 * Whether a box's image belongs to its organization rather than to the
 * operator's curated set.
 *
 * One reader for the one question three call sites ask: whether to pull
 * anonymously, whether to revalidate a tag, and whether to record the image in
 * the organization's catalog. All three used to recompute it from `box.image`
 * against the curated set as it stands at that moment, which is not the set the
 * box was created against — an operator rotating a curated reference makes
 * every box still running the old one look tenant-owned.
 *
 * A row written before the column exists has nothing recorded, and recomputing
 * is the best answer there is for it. That is the old behaviour, kept exactly,
 * for exactly the rows that cannot have anything better.
 */
export function boxImageIsOrgOwned(box: Pick<Box, 'image' | 'imageIsOrgOwned'>): boolean {
  return box.imageIsOrgOwned ?? !isCuratedSelector(box.image)
}

/**
 * Whether the runner may answer this box's image from its own cache.
 *
 * Two conditions, and the first is why this lives here rather than beside the
 * ref-shape rules: the operator's curated images are never revalidated, and
 * whether this box's image is one of them is a recorded fact about the box, not
 * a property of the string. The second is: a ref already pinned to a digest has
 * nothing left to re-resolve.
 */
export function boxImageNeedsRevalidate(box: Pick<Box, 'image' | 'imageIsOrgOwned'>): boolean {
  return boxImageIsOrgOwned(box) && !isDigestPinned(box.image ?? '')
}
