/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxTelemetryService } from './sandbox-telemetry.service'

describe('SandboxTelemetryService', () => {
  function buildService() {
    const clickhouseService = {
      query: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
    }

    return {
      clickhouseService,
      service: new SandboxTelemetryService(clickhouseService as any),
    }
  }

  it('merges gauge, sum, and histogram metric tables into one response', async () => {
    const { service, clickhouseService } = buildService()
    clickhouseService.query
      .mockResolvedValueOnce([
        { timestamp: '2026-05-25T00:00:00.000Z', MetricName: 'nodejs.eventloop.utilization', value: 0.4 },
      ])
      .mockResolvedValueOnce([{ timestamp: '2026-05-25T00:00:00.000Z', MetricName: 'process.cpu.time', value: 12 }])
      .mockResolvedValueOnce([
        { timestamp: '2026-05-25T00:00:00.000Z', MetricName: 'http.server.duration', value: 125 },
      ])

    const result = await service.getMetrics(
      'sandbox-id-is-ignored-for-plan-b',
      '2026-05-25T00:00:00.000Z',
      '2026-05-25T01:00:00.000Z',
    )

    expect(clickhouseService.query).toHaveBeenCalledTimes(3)
    expect(clickhouseService.query.mock.calls[0][0]).toContain('FROM otel_metrics_gauge')
    expect(clickhouseService.query.mock.calls[1][0]).toContain('FROM otel_metrics_sum')
    expect(clickhouseService.query.mock.calls[2][0]).toContain('FROM otel_metrics_histogram')
    expect(result.series).toEqual([
      {
        metricName: 'nodejs.eventloop.utilization',
        dataPoints: [{ timestamp: '2026-05-25T00:00:00.000Z', value: 0.4 }],
      },
      {
        metricName: 'process.cpu.time',
        dataPoints: [{ timestamp: '2026-05-25T00:00:00.000Z', value: 12 }],
      },
      {
        metricName: 'http.server.duration',
        dataPoints: [{ timestamp: '2026-05-25T00:00:00.000Z', value: 125 }],
      },
    ])
  })

  it('exposes platform-specific methods that do not require a sandbox id', async () => {
    const { service, clickhouseService } = buildService()
    clickhouseService.query.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([])

    await service.getPlatformLogs('2026-05-25T00:00:00.000Z', '2026-05-25T01:00:00.000Z', 1, 100)

    expect(clickhouseService.query.mock.calls[0][1]).toMatchObject({
      serviceName: 'boxlite-api',
    })
  })
})
