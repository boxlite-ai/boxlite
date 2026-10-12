// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export const DEFAULT_CLICKHOUSE_RETENTION_HOURS = 30 * 24

export function clickHouseRetentionHours(environment: NodeJS.ProcessEnv): number {
  const value = environment.CLICKHOUSE_RETENTION_HOURS?.trim()
  if (!value) return DEFAULT_CLICKHOUSE_RETENTION_HOURS
  const hours = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(hours) || hours < 1) {
    throw new Error('CLICKHOUSE_RETENTION_HOURS must be a positive safe integer in hours')
  }
  return hours
}
