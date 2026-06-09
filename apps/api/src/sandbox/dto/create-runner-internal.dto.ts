/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type CreateRunnerV0InternalDto = {
  domain: string
  apiUrl: string
  proxyUrl: string
  cpu: number
  memoryGiB: number
  diskGiB: number
  regionId: string
  name: string
  apiKey?: string
  apiVersion: '0'
  appVersion?: string
}

export type CreateRunnerV2InternalDto = {
  apiKey?: string
  regionId: string
  name: string
  apiVersion: '2'
  appVersion?: string
  /**
   * Whether this runner supports security-options enforcement in the v2 job payload.
   * Defaults to true for new registrations — runners created post-deployment are
   * assumed to run a binary that enforces the field.  Pass false explicitly to opt
   * out during a staged rollout or for testing with an older binary.
   */
  supportsSecurityOptions?: boolean
}

export type CreateRunnerInternalDto = CreateRunnerV0InternalDto | CreateRunnerV2InternalDto
