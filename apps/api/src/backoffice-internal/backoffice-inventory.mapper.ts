/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Box } from '../box/entities/box.entity'
import type { Runner } from '../box/entities/runner.entity'

const GIBIBYTE = 1024 ** 3

export interface BackofficeBoxSummary {
  id: string
  name: string
  organizationId: string
  runnerId: string | null
  regionId: string
  desiredState: Box['desiredState']
  observedState: Box['state']
  resources: {
    cpuMillis: number
    memoryBytes: string
    storageBytes: string
  }
  activeJobCount: number
  observedAt: string
  createdAt: string
  updatedAt: string
}

export interface BackofficeRunnerSummary {
  id: string
  name: string
  regionId: string
  state: Runner['state']
  unschedulable: boolean
  draining: boolean
  versions: {
    api: string
    app: string | null
  }
  capacity: {
    cpuMillis: number
    memoryBytes: string
    storageBytes: string
  }
  allocated: {
    cpuMillis: number
    memoryBytes: string
    storageBytes: string
  }
  usage: {
    cpuPercentage: number
    memoryPercentage: number
    storagePercentage: number
  }
  boxCount: number
  startedBoxCount: number
  activeJobCount: number
  queueDepth: number
  availabilityScore: number
  lastHeartbeatAt: string | null
  observedAt: string
  createdAt: string
  updatedAt: string
}

export interface BackofficeRunnerCounts {
  boxCount: number
  activeJobCount: number
  queueDepth: number
}

function gibibytesToBytes(value: number): string {
  return Math.round(value * GIBIBYTE).toString()
}

function coresToMillis(value: number): number {
  return Math.round(value * 1000)
}

export function toBackofficeBoxSummary(box: Box, activeJobCount: number): BackofficeBoxSummary {
  return {
    id: box.id,
    name: box.name,
    organizationId: box.organizationId,
    runnerId: box.runnerId ?? null,
    regionId: box.region,
    desiredState: box.desiredState,
    observedState: box.state,
    resources: {
      cpuMillis: coresToMillis(box.cpu),
      memoryBytes: gibibytesToBytes(box.mem),
      storageBytes: gibibytesToBytes(box.disk),
    },
    activeJobCount,
    observedAt: box.updatedAt.toISOString(),
    createdAt: box.createdAt.toISOString(),
    updatedAt: box.updatedAt.toISOString(),
  }
}

export function toBackofficeRunnerSummary(runner: Runner, counts: BackofficeRunnerCounts): BackofficeRunnerSummary {
  return {
    id: runner.id,
    name: runner.name,
    regionId: runner.region,
    state: runner.state,
    unschedulable: runner.unschedulable,
    draining: runner.draining,
    versions: { api: runner.apiVersion, app: runner.appVersion },
    capacity: {
      cpuMillis: coresToMillis(runner.cpu),
      memoryBytes: gibibytesToBytes(runner.memoryGiB),
      storageBytes: gibibytesToBytes(runner.diskGiB),
    },
    allocated: {
      cpuMillis: coresToMillis(runner.currentAllocatedCpu),
      memoryBytes: gibibytesToBytes(runner.currentAllocatedMemoryGiB),
      storageBytes: gibibytesToBytes(runner.currentAllocatedDiskGiB),
    },
    usage: {
      cpuPercentage: runner.currentCpuUsagePercentage,
      memoryPercentage: runner.currentMemoryUsagePercentage,
      storagePercentage: runner.currentDiskUsagePercentage,
    },
    boxCount: counts.boxCount,
    startedBoxCount: runner.currentStartedBoxes,
    activeJobCount: counts.activeJobCount,
    queueDepth: counts.queueDepth,
    availabilityScore: runner.availabilityScore,
    lastHeartbeatAt: runner.lastChecked?.toISOString() ?? null,
    observedAt: runner.updatedAt.toISOString(),
    createdAt: runner.createdAt.toISOString(),
    updatedAt: runner.updatedAt.toISOString(),
  }
}
