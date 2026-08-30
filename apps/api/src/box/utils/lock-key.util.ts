/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'

export function getStateChangeLockKey(id: string): string {
  return `box:${id}:state-change`
}

export function getRunnerAssignmentLockKey(id: string): string {
  return `runner:${id}:box-assignment`
}

/**
 * The lock that marks one migration job as in flight for a box.
 *
 * It is taken by the loop that submits the job and released by the receiver of
 * that job's status, so it spans the runner's work rather than the tick that
 * started it — the `box_migration` row's state alone cannot tell a submitted job
 * from a pending one. Derived from the job so both ends compute the same key.
 */
export function getMigrateJobLockKey(boxId: string, jobType: JobType): string {
  return `box:${boxId}:migrate:${jobType}`
}
