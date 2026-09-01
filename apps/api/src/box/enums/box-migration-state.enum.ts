/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Where a box is in a migration from one runner to another.
 *
 * A box that is not migrating has no `box_migration` row at all, so there is no
 * state for it; every value here names a job the migration is waiting on, and is
 * left behind by that job's receiver:
 *
 *     (no row) ─▶ PENDING_EXPORT ─▶ PENDING_IMPORT ─▶ PENDING_DISCARD_EXPORTED ─▶ COMPLETED
 *                       └──────────────┴──▶ PENDING_ROLLBACK ─▶ (row deleted)
 *
 * PENDING_EXPORT has a second way out: an EXPORT_BOX that failed deletes the row
 * outright, since a migration that has not exported yet owns no artifact. The
 * box becomes unclaimed again and the marker decides afresh whether to move it.
 *
 * The state records what the migration is waiting for, never what it has
 * produced: `box_migration.arcPath` says an archive is on the object store and
 * `box_migration.runnerId` says a box exists on another runner. Nor does the
 * state mark a job as in flight — a box sits in PENDING_IMPORT both before its
 * IMPORT_BOX job is submitted and while it runs, and the per-box Redis lock is
 * what tells those two apart.
 */
export enum BoxMigrationState {
  PENDING_EXPORT = 'pending_export',
  PENDING_IMPORT = 'pending_import',
  PENDING_DISCARD_EXPORTED = 'pending_discard_exported',
  PENDING_ROLLBACK = 'pending_rollback',
  COMPLETED = 'completed',
}
