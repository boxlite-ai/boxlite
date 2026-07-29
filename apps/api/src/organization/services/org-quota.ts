/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

/** The per-organization ceilings from the OrganizationQuota row. A ceiling of 0
 * denies all usage of that dimension (a 2-cpu box cannot fit in a 0 cpu quota) —
 * matching upstream aggregate-quota semantics. */
export interface OrgQuotaLimits {
  totalCpuQuota: number
  totalMemoryQuota: number
  totalDiskQuota: number
  totalGpuQuota: number
  maxConcurrentBoxes: number
}

/** Applied when an organization has no OrganizationQuota row. Must stay in sync
 * with the entity column defaults and the backfill migration. */
export const DEFAULT_ORG_QUOTA: OrgQuotaLimits = {
  totalCpuQuota: 64,
  totalMemoryQuota: 256,
  totalDiskQuota: 512,
  totalGpuQuota: 0,
  maxConcurrentBoxes: 50,
}

/** A snapshot of what an organization already consumes, in the same units as the
 * limits. The service builds this as (current usage + pending reservation), so it
 * already accounts for the box being created/started. */
export interface OrgResourceUsage {
  cpu: number
  memory: number
  disk: number
  gpu: number
  count: number
}

/**
 * Reject a box create/start whose projected usage would push the organization past
 * any of its ceilings. `usage` is the already-summed (current + pending + this
 * request) figure, so this is a pure comparison — the reservation math lives in the
 * usage service. Every violated dimension is reported in one message.
 *
 * GPU has a fast reject: requesting a GPU box in an org whose GPU quota is zero is
 * refused outright, rather than reported as an over-limit number.
 */
export function assertWithinOrgQuota(limits: OrgQuotaLimits, usage: OrgResourceUsage, requestedGpu: number): void {
  if (requestedGpu > 0 && limits.totalGpuQuota <= 0) {
    throw new BadRequestException('GPU boxes are not available for this organization')
  }

  const violations: string[] = []
  if (usage.cpu > limits.totalCpuQuota) {
    violations.push(`CPU limit exceeded (max ${limits.totalCpuQuota} vCPU)`)
  }
  if (usage.memory > limits.totalMemoryQuota) {
    violations.push(`memory limit exceeded (max ${limits.totalMemoryQuota}GB)`)
  }
  if (usage.disk > limits.totalDiskQuota) {
    violations.push(`disk limit exceeded (max ${limits.totalDiskQuota}GB)`)
  }
  if (usage.gpu > limits.totalGpuQuota) {
    violations.push(`GPU limit exceeded (max ${limits.totalGpuQuota})`)
  }
  if (usage.count > limits.maxConcurrentBoxes) {
    violations.push(`concurrent box limit exceeded (max ${limits.maxConcurrentBoxes})`)
  }

  if (violations.length > 0) {
    throw new BadRequestException(`Organization quota exceeded: ${violations.join('; ')}`)
  }
}
