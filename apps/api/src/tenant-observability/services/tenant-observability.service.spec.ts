/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { TenantTelemetrySource } from '../dto/tenant-observability-query.dto'
import { TenantObservabilityService } from './tenant-observability.service'

describe('TenantObservabilityService', () => {
  const clickhouse = {
    isConfigured: jest.fn(() => true),
    query: jest.fn(),
  }
  const boxService = {
    getOrganizationId: jest.fn(),
  }
  const service = new TenantObservabilityService(clickhouse as never, boxService as never)
  const range = {
    from: '2026-08-15T10:00:00.000Z',
    to: '2026-08-15T11:00:00.000Z',
    page: 1,
    limit: 50,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    clickhouse.isConfigured.mockReturnValue(true)
    boxService.getOrganizationId.mockResolvedValue('org-a')
  })

  it('uses a tenant-scoped fixed query and treats search metacharacters literally', async () => {
    clickhouse.query.mockResolvedValueOnce([{ count: 1 }]).mockResolvedValueOnce([
      {
        Timestamp: '2026-08-15T10:30:00.000Z',
        Body: 'failed at 100%_\\path',
        SeverityText: 'ERROR',
        SeverityNumber: 17,
        ServiceName: 'boxlite-runner',
        ResourceAttributes: {},
        LogAttributes: { 'boxlite.organization.id': 'org-a' },
        TraceId: 'a'.repeat(32),
        SpanId: 'b'.repeat(16),
      },
    ])

    const result = await service.getLogs('org-a', {
      ...range,
      search: '%_\\',
      sources: [TenantTelemetrySource.RUNNER],
    })

    const [countSql, params] = clickhouse.query.mock.calls[0]
    expect(countSql).toContain('boxlite.organization.id')
    expect(countSql).toContain('positionCaseInsensitiveUTF8(Body, {search:String}) > 0')
    expect(countSql).not.toContain('ILIKE')
    expect(params).toMatchObject({ organizationId: 'org-a', search: '%_\\', sources: ['runner'] })
    expect(result.items[0]).toMatchObject({ body: 'failed at 100%_\\path', serviceName: 'boxlite-runner' })
  })

  it('rejects a Box outside the authenticated organization before querying ClickHouse', async () => {
    boxService.getOrganizationId.mockRejectedValue(new NotFoundException())

    await expect(service.getLogs('org-a', { ...range, boxId: 'box-b' })).rejects.toBeInstanceOf(NotFoundException)
    expect(clickhouse.query).not.toHaveBeenCalled()
  })

  it('rejects time ranges longer than 24 hours', async () => {
    await expect(
      service.getTraces('org-a', {
        ...range,
        to: '2026-08-16T10:00:00.001Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(clickhouse.query).not.toHaveBeenCalled()
  })

  it('loads trace detail by tenant and trace instead of a single service name', async () => {
    clickhouse.query.mockResolvedValue([
      {
        TraceId: 'a'.repeat(32),
        SpanId: 'b'.repeat(16),
        ParentSpanId: '',
        SpanName: 'POST /boxes',
        ServiceName: 'boxlite-api',
        Timestamp: range.from,
        Duration: 1_000_000,
        SpanAttributes: {},
        StatusCode: 'OK',
        StatusMessage: '',
        source: 'api',
      },
      {
        TraceId: 'a'.repeat(32),
        SpanId: 'c'.repeat(16),
        ParentSpanId: 'b'.repeat(16),
        SpanName: 'boxlite.runtime.create',
        ServiceName: 'boxlite-runner',
        Timestamp: range.from,
        Duration: 500_000,
        SpanAttributes: {},
        StatusCode: 'OK',
        StatusMessage: '',
        source: 'runtime-wrapper',
      },
    ])

    const spans = await service.getTraceSpans('org-a', 'a'.repeat(32))

    const [sql, params] = clickhouse.query.mock.calls[0]
    expect(sql).toContain('TraceId = {traceId:String}')
    expect(sql).toContain('boxlite.organization.id')
    expect(sql).not.toContain('ServiceName = {serviceName:String}')
    expect(params).toMatchObject({ organizationId: 'org-a', traceId: 'a'.repeat(32) })
    expect(spans.map((span) => span.layer)).toEqual(['api', 'runtime-wrapper'])
  })

  it('only permits allowlisted Box metrics', async () => {
    await expect(
      service.getMetrics('org-a', {
        ...range,
        boxId: 'box-a',
        metricNames: ['host.secret.metric'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(clickhouse.query).not.toHaveBeenCalled()
  })
})
