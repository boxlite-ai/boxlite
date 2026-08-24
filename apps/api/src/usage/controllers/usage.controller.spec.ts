/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { UsageConcurrencyGranularity, UsageConcurrencyQueryDto } from '../dto/usage-concurrency.dto'
import { UsageConcurrencyService } from '../services/usage-concurrency.service'
import { UsageController } from './usage.controller'

describe('UsageController', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const getSeries = jest.fn()
  const controller = new UsageController({ getSeries } as unknown as UsageConcurrencyService)

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now)
    getSeries.mockReset().mockResolvedValue({})
  })

  afterEach(() => jest.useRealTimers())

  it('mounts organization concurrency as a direct organization resource', () => {
    const getConcurrency = Object.getOwnPropertyDescriptor(UsageController.prototype, 'getConcurrency')?.value

    expect(Reflect.getMetadata(PATH_METADATA, UsageController)).toBe('organizations/:organizationId')
    expect(Reflect.getMetadata(PATH_METADATA, getConcurrency)).toBe('/concurrency')
  })

  it('forwards the default 30-day daily range to the concurrency service', async () => {
    await controller.getConcurrency('org-1', {} as UsageConcurrencyQueryDto)

    expect(getSeries).toHaveBeenCalledWith(
      'org-1',
      new Date('2026-07-01T12:00:00.000Z'),
      now,
      UsageConcurrencyGranularity.DAY,
    )
  })
})
