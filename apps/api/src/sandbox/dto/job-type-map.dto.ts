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
  [JobType.CREATE_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.START_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.STOP_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.DESTROY_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.RESIZE_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.CREATE_BACKUP]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.BUILD_ARTIFACT]: {
    resourceType: [ResourceType.SANDBOX, ResourceType.ARTIFACT]
  }
  [JobType.PULL_ARTIFACT]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.REMOVE_ARTIFACT]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.UPDATE_SANDBOX_NETWORK_SETTINGS]: {
    resourceType: [ResourceType.SANDBOX]
  }
  [JobType.INSPECT_ARTIFACT_IN_REGISTRY]: {
    resourceType: [ResourceType.ARTIFACT]
  }
  [JobType.RECOVER_SANDBOX]: {
    resourceType: [ResourceType.SANDBOX]
  }
}

/**
 * Helper type to extract the allowed resource types for a given JobType as a union
 */
export type ResourceTypeForJobType<T extends JobType> = JobTypeMap[T]['resourceType'][number]
