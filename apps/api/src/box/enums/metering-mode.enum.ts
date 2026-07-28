/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * How a Box's current state should be metered.
 *
 * This is a classification of Box state, not a billing decision, which is why
 * it lives under box/ rather than usage/ — the runtime lease reconciler needs
 * it to describe a transition even when nothing is metering. The metering
 * module consumes it; it does not own it.
 */
export enum MeteringMode {
  /** Box is running and authorized: charge compute and disk. */
  FULL = 'full',
  /** Box is stopped or its runtime is gone: the disk still exists, compute does not. */
  DISK_ONLY = 'disk_only',
  /** Not billable at all — warm-pool, destroyed, or archived. */
  NONE = 'none',
  /** Transitional: leave whatever mode is already in effect alone. */
  PRESERVE = 'preserve',
}
