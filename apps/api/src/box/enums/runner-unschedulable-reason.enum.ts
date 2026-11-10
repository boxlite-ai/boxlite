/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The reason the disk-expansion controller set `runner.unschedulable`; the
 * single value keeps foreign marks reasonless, so lifting keys on the reason
 * and can never lift a mark the controller does not own.
 */
export enum RunnerUnschedulableReason {
  /** The data disk cannot grow further: budget spent or the cap reached. */
  DISK_EXPAND_EXHAUSTED = 'disk_expand_exhausted',
}
