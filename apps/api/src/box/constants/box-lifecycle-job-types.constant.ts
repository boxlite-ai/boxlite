/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'

export const BOX_LIFECYCLE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  JobType.CREATE_BOX,
  JobType.START_BOX,
  JobType.STOP_BOX,
  JobType.DESTROY_BOX,
  JobType.RESIZE_BOX,
  JobType.RECOVER_BOX,
])

export function isBoxLifecycleJobType(jobType: JobType): boolean {
  return BOX_LIFECYCLE_JOB_TYPES.has(jobType)
}
