/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ScheduleConfig } from '../entities/warm-pool.entity'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * Resolve the target warm-pool size for a given instant.
 *
 * Pure and clock-injected (`now`) so the branchy schedule logic — timezone
 * conversion, midnight-wrap, first-match, day matching, all-day fallback — is
 * deterministically testable without a real clock or DB.
 *
 * - `scheduleConfig` null/undefined → the static `staticPool` value (backward compatible).
 * - Windows are evaluated in order; first match wins.
 * - A window without `days` matches every day; without `startHour`/`endHour`
 *   matches every hour. `startHour > endHour` wraps past midnight.
 * - No window matches → fall back to `staticPool`.
 *
 * @param timezone IANA timezone used to derive the local hour/weekday (defaults to UTC).
 */
export function resolveWarmPoolTarget(
  scheduleConfig: ScheduleConfig | null | undefined,
  timezone: string | null | undefined,
  staticPool: number,
  now: Date,
): number {
  if (!scheduleConfig) return staticPool

  const tz = timezone ?? 'UTC'
  const parts = new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
    timeZone: tz,
  }).formatToParts(now)

  // Intl can emit "24" for midnight under hour12:false; normalise to 0-23.
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const day = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number])

  for (const w of scheduleConfig.windows) {
    const dayMatch = !w.days || w.days.includes(day)
    const hourMatch =
      w.startHour == null || w.endHour == null
        ? true // no hours specified = all day
        : w.startHour <= w.endHour
          ? hour >= w.startHour && hour < w.endHour
          : hour >= w.startHour || hour < w.endHour // spans midnight
    if (dayMatch && hourMatch) return w.pool
  }

  return staticPool
}
