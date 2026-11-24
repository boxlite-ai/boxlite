// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Injectable } from '@nestjs/common'
import type { RunnerDataDiskRef } from '../common/runner-data-disk-ref'
import { GcpDiskClient, toExpansionClientError } from './gcp-disk-client'
import { AwsDiskClient, toAwsDiskClientError } from './aws-disk-client'
import type { DiskClientLike, DiskPerformanceFields } from './disk-client-contract'

export function toDiskClientError(ref: RunnerDataDiskRef, error: unknown): Error {
  if (ref.provider === 'gcp') return toExpansionClientError(error)
  if (ref.provider === 'aws') return toAwsDiskClientError(error)
  return error instanceof Error ? error : new Error(String(error))
}

@Injectable()
export class CloudDiskClient implements DiskClientLike {
  constructor(
    private readonly gcp: GcpDiskClient,
    private readonly aws: AwsDiskClient,
  ) {}
  resizeDisk(ref: RunnerDataDiskRef, sizeGb: number, performance?: DiskPerformanceFields, runnerName?: string) {
    switch (ref.provider) {
      case 'gcp':
        return this.gcp.resizeDisk(ref, sizeGb, performance)
      case 'aws':
        if (performance) throw new Error('AWS capacity growth preserves provisioned performance')
        return this.aws.resizeDisk(ref, sizeGb, runnerName)
      default:
        throw new Error(`Unsupported disk provider: ${ref.provider}`)
    }
  }
  getDisk(ref: RunnerDataDiskRef) {
    if (ref.provider !== 'gcp') throw new Error('Performance baseline reads require a GCP disk')
    return this.gcp.getDisk(ref)
  }
  getZoneOperation(ref: RunnerDataDiskRef, operation: string, runnerName?: string) {
    switch (ref.provider) {
      case 'gcp':
        return this.gcp.getZoneOperation(ref, operation)
      case 'aws':
        return this.aws.getZoneOperation(ref, operation, runnerName)
      default:
        throw new Error(`Unsupported disk provider: ${ref.provider}`)
    }
  }
}

/** Physical API budgets remain enforced even when an operator configures a larger local budget. */
export function diskExpansionBudget(
  ref: RunnerDataDiskRef,
  settings: { growthWindowHours: number; maxExpansionsPerWindow: number },
) {
  return ref.provider === 'aws'
    ? { hours: Math.max(24, settings.growthWindowHours), count: Math.min(4, settings.maxExpansionsPerWindow) }
    : { hours: settings.growthWindowHours, count: settings.maxExpansionsPerWindow }
}
