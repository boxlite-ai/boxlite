/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** A restore of a snapshot into a box: PENDING until its runner job settles. */
export enum BoxSnapshotRestoreState {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}
