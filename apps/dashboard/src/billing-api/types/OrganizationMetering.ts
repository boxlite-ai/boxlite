/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type MeteringPeriodKind = 'running' | 'stopped'
export type MeteringPeriodSource = 'box_usage_period' | 'box_usage_period_archive'

export interface MeteringTotals {
  cpuSeconds: number
  memGibSeconds: number
  diskGibSeconds: number
  gpuSeconds: number
}

export interface MeteringPeriod {
  id: string
  source: MeteringPeriodSource
  sourcePeriodId?: string
  boxId: string
  organizationId: string
  region: string | null
  startAt: string
  endAt: string | null
  kind: MeteringPeriodKind
  cpu: number
  mem: number
  disk: number
  gpu: number
  durationSeconds: number
  active: boolean
  actualCpuSeconds: number | null
  actualRssAvgBytes: string | null
  actualRssPeakBytes: string | null
  sampleCount: number | null
}

export interface OrganizationMetering {
  organizationId: string
  from: string
  to: string
  activePeriods: MeteringPeriod[]
  archivedPeriods: MeteringPeriod[]
  totals: MeteringTotals
}

export interface OrganizationMeteringParams {
  from?: string
  to?: string
  limit?: number
  boxId?: string
}
