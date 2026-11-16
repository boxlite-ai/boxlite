/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum RunnerDiskExpansionStatus {
  /** GCP accepted the resize; waiting for the runner filesystem to report the new size. */
  PENDING = 'pending',
  /** The runner's reported diskGiB reached the requested size. */
  CONFIRMED = 'confirmed',
  /** Never accepted, the operation itself failed, or confirmation timed out; see the error column. */
  FAILED = 'failed',
}
