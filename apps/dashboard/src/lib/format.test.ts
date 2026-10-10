/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it, vi } from 'vitest'

import { formatBytes, timeAgo } from './format'

describe('formatBytes', () => {
  /**
   * The distinction the size column lives or dies on. A curated image's bytes
   * were never measured by this system, and "0 B" would state that they were
   * and came to nothing.
   */
  it('tells an unmeasured size apart from an empty one', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
  })

  it('reports binary units, the ones a manifest counts in', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(26 * 1024 * 1024)).toBe('26 MiB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GiB')
  })

  // A decimal on a two-digit value is noise in a column that has to line up;
  // below ten it is the difference between "1 GiB" and "1.9 GiB".
  it('keeps one decimal only while it still says something', () => {
    expect(formatBytes(9.4 * 1024 ** 2)).toBe('9.4 MiB')
    expect(formatBytes(11.4 * 1024 ** 2)).toBe('11 MiB')
  })

  it('stops at the largest unit it knows rather than inventing one', () => {
    expect(formatBytes(3 * 1024 ** 5)).toBe('3072 TiB')
  })
})

describe('timeAgo', () => {
  function at(now: string, value: string | null | undefined): string {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    try {
      return timeAgo(value)
    } finally {
      vi.useRealTimers()
    }
  }

  /**
   * `never` rather than a blank cell: an image or volume nothing has touched
   * is a fact these columns exist to report, not data that went missing.
   */
  it('says never for something never used', () => {
    expect(at('2026-01-01T12:00:00Z', null)).toBe('never')
    expect(at('2026-01-01T12:00:00Z', undefined)).toBe('never')
  })

  it('coarsens as the gap grows, since these columns answer "is this stale"', () => {
    expect(at('2026-01-01T12:00:00Z', '2026-01-01T11:59:30Z')).toBe('just now')
    expect(at('2026-01-01T12:00:00Z', '2026-01-01T11:15:00Z')).toBe('45m ago')
    expect(at('2026-01-01T12:00:00Z', '2026-01-01T09:00:00Z')).toBe('3h ago')
    expect(at('2026-01-05T12:00:00Z', '2026-01-01T12:00:00Z')).toBe('4d ago')
  })

  // The boundaries the three branches turn on, where an off-by-one would read
  // as "60m ago" or "24h ago" instead of rolling over.
  it('rolls over at the hour and the day rather than counting past them', () => {
    expect(at('2026-01-01T12:00:00Z', '2026-01-01T11:00:00Z')).toBe('1h ago')
    expect(at('2026-01-02T12:00:00Z', '2026-01-01T12:00:00Z')).toBe('1d ago')
  })
})
