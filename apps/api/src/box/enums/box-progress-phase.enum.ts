/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * What a box in flight is waiting on.
 *
 * Deliberately not a `BoxState`: a box preparing its image is creating, and
 * adding a state for it would make every consumer of `BoxState` handle a value
 * that means the same thing as one they already handle. This says what the
 * creating is spent on, which is extra information rather than a different
 * lifecycle.
 */
export enum BoxProgressPhase {
  /** The image has not been pulled onto a runner before, so this box waits for it. */
  PREPARING_IMAGE = 'preparing_image',
}
