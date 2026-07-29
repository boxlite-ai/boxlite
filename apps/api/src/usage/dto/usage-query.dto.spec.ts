/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { validate } from 'class-validator'
import { UsageRangeQueryDto } from './usage-query.dto'

function query(from: string, to: string): UsageRangeQueryDto {
  return Object.assign(new UsageRangeQueryDto(), { from, to })
}

describe('UsageRangeQueryDto', () => {
  it('accepts a bounded increasing RFC3339 range', async () => {
    await expect(validate(query('2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'))).resolves.toEqual([])
  })

  it.each([
    ['not-a-date', '2026-07-02T00:00:00.000Z'],
    ['2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z'],
    ['2025-01-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'],
  ])('rejects invalid or unsafe range %s to %s', async (from, to) => {
    const errors = await validate(query(from, to))
    expect(errors.length).toBeGreaterThan(0)
  })
})
