/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Mirrors BoxState's naming (creating/destroying/destroyed/error) so the two
// resources read consistently. No separate pending_* stage: a volume moves
// straight to CREATING/DESTROYING on request, same as a box does — the
// reconciler's per-volume Redis lock (see VolumeManager) already distinguishes
// "queued" from "being processed", so a DB-level pending stage was redundant.
export enum VolumeState {
  CREATING = 'creating',
  READY = 'ready',
  DESTROYING = 'destroying',
  DESTROYED = 'destroyed',
  ERROR = 'error',
}

// Labels retired by the volume-state simplification. They are deliberately
// absent from VolumeState — no current code writes them — but rows can still
// carry them: the migration runs pre-deploy, so instances on the previous
// release keep writing pending_create/pending_delete until the rollout
// finishes, after the migration's one-shot row conversion has already run.
// The reconciler therefore polls these too and canonicalizes on read, so such
// a row is picked up instead of stranded once its writer goes away.
//
// 'deleted' is absent here on purpose: it is terminal, so nothing needs to
// reconcile it.
export const RETIRED_VOLUME_STATES = ['pending_create', 'pending_delete', 'deleting'] as const

const RETIRED_TO_CANONICAL: Record<string, VolumeState> = {
  pending_create: VolumeState.CREATING,
  pending_delete: VolumeState.DESTROYING,
  deleting: VolumeState.DESTROYING,
  deleted: VolumeState.DESTROYED,
}

/** Maps a retired label onto its current equivalent; current labels pass through. */
export function canonicalVolumeState(state: VolumeState | string): VolumeState {
  return RETIRED_TO_CANONICAL[state] ?? (state as VolumeState)
}
