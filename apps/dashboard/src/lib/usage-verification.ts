/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface BoxUsageTotals {
  boxId: string
  totalCPUSeconds: number
  totalRAMGBSeconds: number
  totalDiskGBSeconds: number
  totalGPUSeconds: number
}

export interface BoxUsagePeriodRow {
  id: string
  boxId: string
  organizationId: string
  region: string | null
  kind: string
  periodStart: string
  periodEnd: string | null
  allocCpu: number
  allocMemGib: number
  allocDiskGib: number
  createdAt: string
  updatedAt: string
}

export interface UsageDelta {
  cpu: number
  ram: number
  disk: number
  gpu: number
}

export function formatUsageSeconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  if (Math.abs(value) < 100) return value.toFixed(2)
  return value.toFixed(1)
}

export function calculateUsageDelta(current?: BoxUsageTotals, previous?: BoxUsageTotals): UsageDelta {
  return {
    cpu: Math.max(0, (current?.totalCPUSeconds ?? 0) - (previous?.totalCPUSeconds ?? 0)),
    ram: Math.max(0, (current?.totalRAMGBSeconds ?? 0) - (previous?.totalRAMGBSeconds ?? 0)),
    disk: Math.max(0, (current?.totalDiskGBSeconds ?? 0) - (previous?.totalDiskGBSeconds ?? 0)),
    gpu: Math.max(0, (current?.totalGPUSeconds ?? 0) - (previous?.totalGPUSeconds ?? 0)),
  }
}

export function formatUsageTimestamp(value: string | null | undefined): string {
  if (!value) return 'NULL'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z')
}
