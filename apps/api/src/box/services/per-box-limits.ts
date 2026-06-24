/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

/** Per-box resource ceilings carried on the organization (the "security
 * option" numbers). A value <= 0 means "unset" and is not enforced. */
export interface PerBoxLimits {
  maxCpuPerBox: number
  maxMemoryPerBox: number
  maxDiskPerBox: number
}

/**
 * Reject a box create whose requested cpu / memory / disk exceeds the org's
 * per-box limits, instead of silently storing out-of-range values. Without
 * this, the API accepted absurd inputs (e.g. cpu=999, memory past 4 GiB) and
 * persisted them, which then poisoned every list_info round-trip for the
 * whole org. Memory and disk are compared in GB (the CreateBoxDto unit).
 */
export function assertWithinPerBoxLimits(cpu: number, memoryGb: number, diskGb: number, limits: PerBoxLimits): void {
  const violations: string[] = []
  if (limits.maxCpuPerBox > 0 && cpu > limits.maxCpuPerBox) {
    violations.push(`cpu ${cpu} exceeds the per-box limit of ${limits.maxCpuPerBox}`)
  }
  if (limits.maxMemoryPerBox > 0 && memoryGb > limits.maxMemoryPerBox) {
    violations.push(`memory ${memoryGb}GB exceeds the per-box limit of ${limits.maxMemoryPerBox}GB`)
  }
  if (limits.maxDiskPerBox > 0 && diskGb > limits.maxDiskPerBox) {
    violations.push(`disk ${diskGb}GB exceeds the per-box limit of ${limits.maxDiskPerBox}GB`)
  }
  if (violations.length > 0) {
    throw new BadRequestException(`Requested resources exceed per-box limits: ${violations.join('; ')}`)
  }
}
