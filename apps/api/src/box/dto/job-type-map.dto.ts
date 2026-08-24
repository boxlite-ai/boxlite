/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'

/**
 * Type-safe mapping between JobType and its corresponding ResourceType(s) + Payload
 * This ensures compile-time safety when creating jobs
 * resourceType is an array of allowed ResourceTypes - the user can supply any of them
 *
 * The resource type is also a namespace: IDX_UNIQUE_INCOMPLETE_JOB allows one
 * incomplete job per (resourceType, resourceId, runnerId). A migration's jobs act
 * on the archive the box travels in rather than on the box itself, and they run
 * against a box a user may start or stop at the same time, so they are namespaced
 * under BACKUP to keep out of the box's own lifecycle slot.
 */
export interface JobTypeMap {
  [JobType.CREATE_BOX]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.START_BOX]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.STOP_BOX]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.DESTROY_BOX]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.EXPORT_BOX]: {
    resourceType: [ResourceType.BACKUP]
  }
  [JobType.IMPORT_BOX]: {
    resourceType: [ResourceType.BACKUP]
  }
  [JobType.ROLLBACK_EXPORT_BOX]: {
    resourceType: [ResourceType.BACKUP]
  }
  [JobType.ROLLBACK_IMPORT_BOX]: {
    resourceType: [ResourceType.BACKUP]
  }
  [JobType.DISCARD_EXPORTED_BOX]: {
    resourceType: [ResourceType.BACKUP]
  }
}

/**
 * Helper type to extract the allowed resource types for a given JobType as a union
 */
export type ResourceTypeForJobType<T extends JobType> = JobTypeMap[T]['resourceType'][number]
