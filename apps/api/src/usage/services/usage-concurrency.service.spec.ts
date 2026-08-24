/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { UsageConcurrencyGranularity } from '../dto/usage-concurrency.dto'
import { UsageConcurrencyService } from './usage-concurrency.service'

const from = new Date('2026-07-01T00:00:00.000Z')
const to = new Date('2026-07-03T00:00:00.000Z')
const now = new Date('2026-07-04T00:00:00.000Z')

describe('UsageConcurrencyService', () => {
  const query = jest.fn()
  const service = new UsageConcurrencyService({ query } as unknown as DataSource)

  beforeEach(() => query.mockReset())

  it('maps the database snapshots and reports the final point as current', async () => {
    query.mockResolvedValue([
      { observedAt: from, runningBoxes: '2' },
      { observedAt: to, runningBoxes: 4 },
    ])

    await expect(service.getSeries('org-1', from, to, UsageConcurrencyGranularity.DAY, now)).resolves.toEqual({
      from,
      to,
      granularity: UsageConcurrencyGranularity.DAY,
      current: 4,
      points: [
        { observedAt: from, runningBoxes: 2 },
        { observedAt: to, runningBoxes: 4 },
      ],
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('FROM "box_usage_periods"')
    expect(sql).toContain('FROM "box_usage_periods_archive"')
    expect(sql).toContain('AND "cpu" > 0')
    expect(sql).toContain('AND "endAt" > $2')
    expect(sql).toContain('COUNT(DISTINCT periods."boxId")')
    expect(sql).toContain('periods."endAt" > moments."observedAt"')
    expect(params).toEqual(['org-1', from, to, '1 day'])
  })

  it('uses hourly sampling for an hourly series', async () => {
    query.mockResolvedValue([])

    await service.getSeries('org-1', from, to, UsageConcurrencyGranularity.HOUR, now)

    expect(query).toHaveBeenCalledWith(expect.any(String), ['org-1', from, to, '1 hour'])
  })

  it('rejects hourly ranges longer than seven days before querying', async () => {
    await expect(
      service.getSeries('org-1', new Date('2026-06-25T00:00:00.000Z'), to, UsageConcurrencyGranularity.HOUR, now),
    ).rejects.toThrow('cannot exceed 7 days')

    expect(query).not.toHaveBeenCalled()
  })

  it('rejects inverted, future, and over-wide ranges before querying', async () => {
    await expect(service.getSeries('org-1', to, from, UsageConcurrencyGranularity.DAY, now)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(
      service.getSeries('org-1', from, new Date('2026-07-05T00:00:00.000Z'), UsageConcurrencyGranularity.DAY, now),
    ).rejects.toThrow('cannot be in the future')
    await expect(
      service.getSeries('org-1', new Date('2026-01-01T00:00:00.000Z'), to, UsageConcurrencyGranularity.DAY, now),
    ).rejects.toThrow('cannot exceed 90 days')

    expect(query).not.toHaveBeenCalled()
  })
})
