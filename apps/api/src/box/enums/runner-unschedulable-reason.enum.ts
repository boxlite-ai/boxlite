/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Who set `runner.unschedulable`; only the API's own disk-pressure mark is lifted automatically. */
export enum RunnerUnschedulableReason {
  OPERATOR = 'operator',
  DISK_PRESSURE = 'disk_pressure',
}
