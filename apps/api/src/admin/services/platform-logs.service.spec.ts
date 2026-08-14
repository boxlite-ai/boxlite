/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { PlatformLogSource, PlatformLogsQueryDto } from '../dto/platform-logs.dto'
import { PlatformLogsService } from './platform-logs.service'

describe('PlatformLogsService', () => {
  const query = {
    source: PlatformLogSource.API,
    from: '2026-08-14T00:00:00.000Z',
    to: '2026-08-14T01:00:00.000Z',
    page: 1,
    limit: 50,
  }

  it('maps allowlisted sources to exact OpenTelemetry service names', async () => {
    const getLogsForService = jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 })
    const service = new PlatformLogsService({ isConfigured: () => true, getLogsForService } as any)

    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    await service.query({ ...query, source: PlatformLogSource.RUNNER, search: 'failed', traceId })

    expect(getLogsForService).toHaveBeenCalledWith(
      'boxlite-runner',
      query.from,
      query.to,
      1,
      50,
      undefined,
      'failed',
      traceId,
      4,
    )
  })

  it('requires an exact box id instead of scanning every box service', async () => {
    const getLogsForService = jest.fn()
    const service = new PlatformLogsService({ isConfigured: () => true, getLogsForService } as any)

    await expect(service.query({ ...query, source: PlatformLogSource.BOX })).rejects.toThrow(
      'boxId is required for Box logs',
    )
    expect(getLogsForService).not.toHaveBeenCalled()
  })

  it('rejects ranges beyond the ClickHouse retention window', async () => {
    const service = new PlatformLogsService({ isConfigured: () => true, getLogsForService: jest.fn() } as any)

    await expect(
      service.query({
        ...query,
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-14T00:00:00.000Z',
      }),
    ).rejects.toThrow('Platform log searches are limited to 72 hours')
  })

  it('reports an unavailable ClickHouse reader instead of an empty result', async () => {
    const service = new PlatformLogsService({ isConfigured: () => false, getLogsForService: jest.fn() } as any)

    await expect(service.query(query)).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('bounds page and limit before they reach ClickHouse', async () => {
    const dto = plainToInstance(PlatformLogsQueryDto, { ...query, page: 1.5, limit: 101 })

    const errors = await validate(dto)

    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['page', 'limit']))
  })
})
