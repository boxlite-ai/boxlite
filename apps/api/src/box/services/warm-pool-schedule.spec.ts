/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ScheduleConfig } from '../entities/warm-pool.entity'
import { resolveWarmPoolTarget } from './warm-pool-schedule'

// Helper: a fixed instant expressed in UTC. Each test picks an instant whose
// LOCAL hour/weekday (in the schedule's timezone) is what we want to exercise.
const at = (iso: string) => new Date(iso)

describe('resolveWarmPoolTarget', () => {
  it('returns the static pool when no schedule is configured', () => {
    expect(resolveWarmPoolTarget(null, 'UTC', 7, at('2026-07-08T12:00:00Z'))).toBe(7)
    expect(resolveWarmPoolTarget(undefined, 'UTC', 3, at('2026-07-08T12:00:00Z'))).toBe(3)
  })

  it('falls back to the static pool when no window matches', () => {
    // Window only covers Mon–Fri 09–18; the instant below is a Wednesday 20:00 UTC.
    const cfg: ScheduleConfig = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, pool: 10 }] }
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T20:00:00Z'))).toBe(1)
  })

  it('matches a weekday business-hours window', () => {
    // 2026-07-08 is a Wednesday. 14:00 UTC is inside 09–18.
    const cfg: ScheduleConfig = { windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, pool: 10 }] }
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T14:00:00Z'))).toBe(10)
  })

  it('uses the first matching window (order wins) and a trailing catch-all', () => {
    const cfg: ScheduleConfig = {
      windows: [
        { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, pool: 10 },
        { pool: 2 }, // catch-all: no days, no hours → always matches
      ],
    }
    // Wednesday 14:00 → first window
    expect(resolveWarmPoolTarget(cfg, 'UTC', 0, at('2026-07-08T14:00:00Z'))).toBe(10)
    // Wednesday 23:00 → outside first, falls to catch-all
    expect(resolveWarmPoolTarget(cfg, 'UTC', 0, at('2026-07-08T23:00:00Z'))).toBe(2)
    // Sunday 14:00 → day excludes first window, catch-all applies
    expect(resolveWarmPoolTarget(cfg, 'UTC', 0, at('2026-07-05T14:00:00Z'))).toBe(2)
  })

  describe('midnight-wrapping window (startHour > endHour)', () => {
    // "Overnight" window 22:00–06:00 every day.
    const cfg: ScheduleConfig = { windows: [{ startHour: 22, endHour: 6, pool: 4 }] }

    it('matches after startHour (late night)', () => {
      expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T23:30:00Z'))).toBe(4)
    })

    it('matches before endHour (early morning)', () => {
      expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T03:00:00Z'))).toBe(4)
    })

    it('does not match the daytime gap', () => {
      expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T12:00:00Z'))).toBe(1)
    })

    it('matches exactly at startHour but not at endHour (half-open interval)', () => {
      expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T22:00:00Z'))).toBe(4) // >= 22
      expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T06:00:00Z'))).toBe(1) // < 6 is exclusive
    })
  })

  it('treats a window without hours as all-day', () => {
    const cfg: ScheduleConfig = { windows: [{ days: [3], pool: 5 }] } // Wednesdays, any hour
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T03:00:00Z'))).toBe(5)
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T21:00:00Z'))).toBe(5)
    // Thursday → no match → static
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-09T03:00:00Z'))).toBe(1)
  })

  it('normalises the midnight hour (Intl "24" guard) so 00:00 matches a window starting at 0', () => {
    const cfg: ScheduleConfig = { windows: [{ startHour: 0, endHour: 6, pool: 8 }] }
    // 00:00 UTC — the % 24 guard maps a possible "24" to 0, which is >= 0 and < 6.
    expect(resolveWarmPoolTarget(cfg, 'UTC', 1, at('2026-07-08T00:00:00Z'))).toBe(8)
  })

  describe('timezone awareness', () => {
    // Same UTC instant resolves to different local hours → different windows.
    const cfg: ScheduleConfig = { windows: [{ startHour: 9, endHour: 18, pool: 10 }, { pool: 1 }] }

    it('is inside business hours in Asia/Shanghai but outside in UTC for the same instant', () => {
      // 02:00 UTC == 10:00 Asia/Shanghai (UTC+8).
      const instant = at('2026-07-08T02:00:00Z')
      expect(resolveWarmPoolTarget(cfg, 'Asia/Shanghai', 0, instant)).toBe(10) // 10:00 local → in window
      expect(resolveWarmPoolTarget(cfg, 'UTC', 0, instant)).toBe(1) // 02:00 UTC → catch-all
    })

    it('shifts the local weekday across the date line', () => {
      // 2026-07-08 22:00 UTC is still Wednesday in UTC but already Thursday in Asia/Shanghai (06:00 Thu).
      const cfgDay: ScheduleConfig = { windows: [{ days: [4], pool: 9 }] } // Thursdays only
      const instant = at('2026-07-08T22:00:00Z')
      expect(resolveWarmPoolTarget(cfgDay, 'Asia/Shanghai', 1, instant)).toBe(9) // Thu locally
      expect(resolveWarmPoolTarget(cfgDay, 'UTC', 1, instant)).toBe(1) // Wed in UTC → no match
    })

    it('respects US Eastern DST (summer offset is UTC-4)', () => {
      // 2026-07-08 is during EDT (UTC-4). 13:00 UTC == 09:00 America/New_York.
      const instant = at('2026-07-08T13:00:00Z')
      expect(resolveWarmPoolTarget(cfg, 'America/New_York', 0, instant)).toBe(10) // 09:00 local → in window
    })

    it('defaults to UTC when timezone is null/undefined', () => {
      const instant = at('2026-07-08T14:00:00Z')
      expect(resolveWarmPoolTarget(cfg, null, 0, instant)).toBe(10)
      expect(resolveWarmPoolTarget(cfg, undefined, 0, instant)).toBe(10)
    })
  })
})
