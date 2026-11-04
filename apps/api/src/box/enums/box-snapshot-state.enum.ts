/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Where a snapshot's archive is in its life:
 *
 *     CREATING ─▶ READY ─┐
 *         └────▶ FAILED ─┴─▶ DELETING ─▶ (row deleted)
 *
 * Only a READY snapshot can be restored. A FAILED one never held a usable
 * archive and stays listed, with its reason, until someone deletes it.
 * DELETING is the reaper's queue: the archive object goes first, the row last.
 */
export enum BoxSnapshotState {
  CREATING = 'creating',
  READY = 'ready',
  FAILED = 'failed',
  DELETING = 'deleting',
}
