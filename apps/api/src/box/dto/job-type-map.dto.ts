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
  [JobType.RESIZE_BOX]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.CREATE_BACKUP]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.PULL_ARTIFACT]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.REMOVE_ARTIFACT]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.UPDATE_BOX_NETWORK_SETTINGS]: {
    resourceType: [ResourceType.BOX]
  }
  [JobType.INSPECT_ARTIFACT_IN_REGISTRY]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.RECOVER_BOX]: {
    resourceType: [ResourceType.BOX]
  }
}

/**
 * Helper type to extract the allowed resource types for a given JobType as a union
 */
export type ResourceTypeForJobType<T extends JobType> = JobTypeMap[T]['resourceType'][number]
