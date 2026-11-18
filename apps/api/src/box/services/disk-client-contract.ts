// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import type { RunnerDataDiskRef } from '../common/runner-data-disk-ref'

export class DiskRateLimitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiskRateLimitedError'
  }
}
export interface DiskOperation {
  status: 'PENDING' | 'RUNNING' | 'DONE'
  error?: string
}
export interface DiskSnapshot {
  sizeGb?: string
  provisionedIops?: string
  provisionedThroughput?: string
}
export interface DiskPerformanceFields {
  iops?: string
  throughput?: string
}
export interface DiskClientLike {
  resizeDisk(
    ref: RunnerDataDiskRef,
    sizeGb: number,
    performance?: DiskPerformanceFields,
    runnerName?: string,
  ): Promise<{ operation: string }>
  getDisk?(ref: RunnerDataDiskRef): Promise<DiskSnapshot>
  getZoneOperation(ref: RunnerDataDiskRef, operation: string, runnerName?: string): Promise<DiskOperation>
}
