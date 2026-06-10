/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import { AdminObservabilityService } from './observability.service'

describe('AdminObservabilityService', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  function buildService(
    options: {
      configured: boolean
      queryRows?: any[]
      clickstackBaseUrl?: string
      clickstackDashboardUrl?: string
      clickstackLogSourceId?: string
      clickstackTraceSourceId?: string
      clickstackMetricSourceId?: string
    } = { configured: true },
  ) {
    const clickhouseService = {
      isConfigured: jest.fn().mockReturnValue(options.configured),
      query: jest.fn().mockResolvedValue(options.queryRows ?? []),
    }
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'observability.clickstackBaseUrl') {
          return options.clickstackBaseUrl
        }
        if (key === 'observability.clickstackDashboardUrl') {
          return options.clickstackDashboardUrl
        }
        if (key === 'observability.clickstackLogSourceId') {
          return options.clickstackLogSourceId
        }
        if (key === 'observability.clickstackTraceSourceId') {
          return options.clickstackTraceSourceId
        }
        if (key === 'observability.clickstackMetricSourceId') {
          return options.clickstackMetricSourceId
        }
        return undefined
      }),
    }
    const overviewService = {
      listBoxes: jest.fn().mockResolvedValue([]),
      listRunners: jest.fn().mockResolvedValue([]),
      listMachines: jest.fn().mockResolvedValue([]),
    }
    const auditService = {
      getAllLogs: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
    }
    const cloudWatchLogReader = {
      getRelatedLogs: jest.fn().mockResolvedValue({
        logs: [],
        status: { source: 'cloudwatch', state: 'available', count: 0 },
      }),
    }
    const s3ObjectReader = {
      listRelatedObjects: jest.fn().mockResolvedValue({
        objects: [],
        status: { source: 's3', state: 'available', count: 0 },
      }),
    }

    return {
      clickhouseService,
      overviewService,
      auditService,
      cloudWatchLogReader,
      s3ObjectReader,
      service: new AdminObservabilityService(
        clickhouseService as any,
        configService as any,
        overviewService as any,
        auditService as any,
        cloudWatchLogReader as any,
        s3ObjectReader as any,
      ),
    }
  }

  it('reports missing backend without querying ClickHouse when it is not configured', async () => {
    const { service, clickhouseService } = buildService({ configured: false })

    await expect(service.getStatus()).resolves.toEqual({
      backend: {
        configured: false,
        state: 'missing',
        message: 'ClickHouse/ClickStack is not configured',
      },
      layers: [
        { layer: 'api', state: 'missing', signals: { logs: 'missing', traces: 'missing', metrics: 'missing' } },
        { layer: 'runner', state: 'missing', signals: { logs: 'missing', traces: 'missing', metrics: 'missing' } },
        { layer: 'ec2_host', state: 'missing', signals: { logs: 'missing', traces: 'missing', metrics: 'missing' } },
        { layer: 'box', state: 'missing', signals: { logs: 'missing', traces: 'missing', metrics: 'missing' } },
      ],
    })
    expect(clickhouseService.query).not.toHaveBeenCalled()
  })

  it('does not return fake empty logs when ClickHouse is not configured', async () => {
    const { service } = buildService({ configured: false })

    await expect(
      service.getLogs({
        from: '2026-06-05T00:00:00.000Z',
        to: '2026-06-05T01:00:00.000Z',
        page: 1,
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('builds admin log queries with layer and resource filters', async () => {
    const { service, clickhouseService } = buildService({ configured: true })

    await service.getLogs({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      page: 2,
      limit: 25,
      layer: 'box',
      serviceName: 'boxlite-box',
      orgId: 'org-1',
      userId: 'user-1',
      boxId: 'box-1',
      runnerId: 'runner-1',
      machineId: 'machine-1',
      severities: ['ERROR'],
      search: 'entrypoint',
    })

    const [countQuery, countParams] = clickhouseService.query.mock.calls[0]
    const [logsQuery, logsParams] = clickhouseService.query.mock.calls[1]

    expect(countQuery).toContain('multiIf(')
    expect(countQuery).toContain("ServiceName = 'boxlite-runner', 'runner'")
    expect(countQuery).toContain('= {layer:String}')
    expect(countQuery).toContain('ServiceName = {serviceName:String}')
    expect(countQuery).toContain("ResourceAttributes['boxlite.org_id'] = {orgId:String}")
    expect(countQuery).toContain("LogAttributes['boxlite.org_id'] = {orgId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.user_id'] = {userId:String}")
    expect(countQuery).toContain("LogAttributes['boxlite.user_id'] = {userId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.box_id'] = {boxId:String}")
    expect(countQuery).toContain("LogAttributes['boxlite.box_id'] = {boxId:String}")
    expect(countQuery).toContain('ServiceName = {boxServiceName:String}')
    expect(countQuery).toContain("ResourceAttributes['boxlite.runner_id'] = {runnerId:String}")
    expect(countQuery).toContain("LogAttributes['boxlite.runner_id'] = {runnerId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.machine_id'] = {machineId:String}")
    expect(countQuery).toContain("LogAttributes['boxlite.machine_id'] = {machineId:String}")
    expect(countQuery).toContain('lower(SeverityText) IN ({severities:Array(String)})')
    expect(logsQuery).toContain('ORDER BY Timestamp DESC')
    expect(countParams).toMatchObject({
      layer: 'box',
      serviceName: 'boxlite-box',
      orgId: 'org-1',
      userId: 'user-1',
      boxId: 'box-1',
      runnerId: 'runner-1',
      machineId: 'machine-1',
      boxServiceName: 'box-box-1',
      severities: ['error'],
      search: '%entrypoint%',
      offset: 25,
      limit: 25,
    })
    expect(logsParams).toEqual(countParams)
  })

  it('builds admin trace queries with span attribute resource filters', async () => {
    const { service, clickhouseService } = buildService({ configured: true })

    await service.getTraces({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      page: 1,
      limit: 25,
      orgId: 'org-1',
      userId: 'user-1',
      boxId: 'box-1',
      runnerId: 'runner-1',
      machineId: 'machine-1',
    })

    const [countQuery, countParams] = clickhouseService.query.mock.calls[0]
    const [tracesQuery, tracesParams] = clickhouseService.query.mock.calls[1]

    expect(countQuery).toContain("ResourceAttributes['boxlite.org_id'] = {orgId:String}")
    expect(countQuery).toContain("SpanAttributes['boxlite.org_id'] = {orgId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.user_id'] = {userId:String}")
    expect(countQuery).toContain("SpanAttributes['boxlite.user_id'] = {userId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.box_id'] = {boxId:String}")
    expect(countQuery).toContain("SpanAttributes['boxlite.box_id'] = {boxId:String}")
    expect(countQuery).toContain('ServiceName = {boxServiceName:String}')
    expect(countQuery).toContain("ResourceAttributes['boxlite.runner_id'] = {runnerId:String}")
    expect(countQuery).toContain("SpanAttributes['boxlite.runner_id'] = {runnerId:String}")
    expect(countQuery).toContain("ResourceAttributes['boxlite.machine_id'] = {machineId:String}")
    expect(countQuery).toContain("SpanAttributes['boxlite.machine_id'] = {machineId:String}")
    expect(tracesQuery).toContain('ORDER BY startTime DESC')
    expect(countParams).toMatchObject({
      orgId: 'org-1',
      userId: 'user-1',
      boxId: 'box-1',
      boxServiceName: 'box-box-1',
      runnerId: 'runner-1',
      machineId: 'machine-1',
    })
    expect(tracesParams).toEqual(countParams)
  })

  it('returns serviceName and resolved layer per span for trace drill-down', async () => {
    const { service, clickhouseService } = buildService({
      configured: true,
      queryRows: [
        {
          TraceId: 'trace-1',
          SpanId: 'span-1',
          ParentSpanId: '',
          SpanName: 'GET /x',
          Timestamp: '2026-06-08 07:00:00',
          Duration: 1000,
          ServiceName: 'box-abc',
          ResourceAttributes: {},
          SpanAttributes: {},
          StatusCode: 'Error',
          StatusMessage: 'boom',
        },
      ],
    })

    const spans = await service.getTraceSpans('trace-1', {
      from: '2026-06-08T00:00:00.000Z',
      to: '2026-06-08T01:00:00.000Z',
      page: 1,
      limit: 50,
    })

    const [spansQuery] = clickhouseService.query.mock.calls[0]
    expect(spansQuery).toContain('ServiceName')
    expect(spans[0]).toMatchObject({
      spanId: 'span-1',
      serviceName: 'box-abc',
      layer: 'box',
    })
  })

  it('uses a default time range when logs are queried without from/to', async () => {
    const { service, clickhouseService } = buildService({ configured: true })

    await service.getLogs({ limit: 5 })

    const [, params] = clickhouseService.query.mock.calls[0]
    expect(params.from).toBeInstanceOf(Date)
    expect(params.to).toBeInstanceOf(Date)
    expect(Number.isNaN(params.from.getTime())).toBe(false)
    expect(Number.isNaN(params.to.getTime())).toBe(false)
    expect(params.to.getTime() - params.from.getTime()).toBe(60 * 60 * 1000)
  })

  it('checks all ClickHouse metric tables when building layer status', async () => {
    const { service, clickhouseService } = buildService({ configured: true })

    await service.getStatus()

    const [statusQuery] = clickhouseService.query.mock.calls[0]
    expect(statusQuery).toContain('otel_metrics_gauge')
    expect(statusQuery).toContain('otel_metrics_sum')
    expect(statusQuery).toContain('otel_metrics_summary')
    expect(statusQuery).toContain('otel_metrics_histogram')
    expect(statusQuery).toContain('otel_metrics_exponential_histogram')
    expect(statusQuery).not.toContain('otel_metrics_exp_histogram')
    expect(statusQuery).toContain("ServiceName = 'boxlite-runner', 'runner'")
  })

  it('reports configured backend clearly when no OTel rows have been observed', async () => {
    const { service } = buildService({ configured: true, queryRows: [] })

    await expect(service.getStatus()).resolves.toMatchObject({
      backend: {
        configured: true,
        state: 'configured',
        message: 'ClickHouse is configured, but no OTel logs, traces, or metrics have been observed yet',
      },
      layers: [
        { layer: 'api', state: 'configured' },
        { layer: 'runner', state: 'configured' },
        { layer: 'ec2_host', state: 'configured' },
        { layer: 'box', state: 'configured' },
      ],
    })
  })

  it('uses epoch milliseconds for layer status freshness to avoid local timezone parsing', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 5, 15, 40, 0, 0))
    const { service, clickhouseService } = buildService({
      configured: true,
      queryRows: [
        {
          layer: 'api',
          signal: 'logs',
          lastSeenMs: String(Date.UTC(2026, 5, 5, 15, 39, 0, 0)),
        },
      ],
    })

    const status = await service.getStatus()
    expect(status.backend).toMatchObject({ configured: true, state: 'receiving' })
    expect(status.layers.find((layer) => layer.layer === 'api')).toMatchObject({
      layer: 'api',
      state: 'receiving',
      signals: { logs: 'receiving', traces: 'configured', metrics: 'configured' },
      lastSeen: '2026-06-05T15:39:00.000Z',
    })

    const [statusQuery] = clickhouseService.query.mock.calls[0]
    expect(statusQuery).toContain('toUnixTimestamp64Milli')
    expect(statusQuery).toContain('lastSeenMs')
  })

  it('queries scalar metrics from gauge and sum tables for charts', async () => {
    const { service, clickhouseService } = buildService({
      configured: true,
      queryRows: [
        {
          timestamp: '2026-06-05T00:00:00.000Z',
          MetricName: 'boxlite.runner.started_boxes',
          layer: 'runner',
          value: 3,
        },
      ],
    })

    await expect(
      service.getMetrics({
        from: '2026-06-05T00:00:00.000Z',
        to: '2026-06-05T01:00:00.000Z',
        page: 1,
        limit: 100,
        layer: 'runner',
        metricNames: ['boxlite.runner.started_boxes'],
      }),
    ).resolves.toEqual({
      series: [
        {
          metricName: 'boxlite.runner.started_boxes',
          layer: 'runner',
          dataPoints: [{ timestamp: '2026-06-05T00:00:00.000Z', value: 3 }],
        },
      ],
    })

    const [metricsQuery, metricsParams] = clickhouseService.query.mock.calls[0]
    expect(metricsQuery).toContain('FROM otel_metrics_gauge')
    expect(metricsQuery).toContain('FROM otel_metrics_sum')
    expect(metricsQuery).toContain('multiIf(')
    expect(metricsQuery).toContain('as layer')
    expect(metricsQuery).toContain('GROUP BY timestamp, MetricName, layer')
    expect(metricsQuery).toContain('MetricName IN ({metricNames:Array(String)})')
    expect(metricsParams).toMatchObject({
      layer: 'runner',
      metricNames: ['boxlite.runner.started_boxes'],
    })
  })

  it('derives box correlation from box service names when resource attributes are not present', async () => {
    const { service, clickhouseService, overviewService, cloudWatchLogReader, s3ObjectReader } = buildService({
      configured: true,
    })
    clickhouseService.query.mockImplementation(async (query: string) => {
      if (query.includes('FROM otel_traces') && query.includes('ResourceAttributes')) {
        return [
          {
            TraceId: 'trace-box-1',
            SpanId: 'span-1',
            ParentSpanId: '',
            SpanName: 'GET /version',
            Timestamp: '2026-06-05T00:00:00.000Z',
            Duration: 1_000_000,
            ServiceName: 'box-box-1',
            ResourceAttributes: {},
            SpanAttributes: {},
            StatusCode: 'STATUS_CODE_OK',
            StatusMessage: '',
          },
        ]
      }
      if (query.includes('SELECT count() as count') && query.includes('FROM otel_logs')) {
        return [{ count: 0 }]
      }
      return []
    })
    overviewService.listBoxes.mockResolvedValue([
      {
        id: 'box-1',
        boxId: 'public-box-1',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-1',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      {
        id: 'box-2',
        boxId: 'public-box-2',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-2',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
    ])
    overviewService.listRunners.mockResolvedValue([{ id: 'runner-1', state: 'ready', draining: false }])
    overviewService.listMachines.mockResolvedValue([{ host: 'runner-1', region: 'us-east-1', boxes: 1 }])

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      traceId: 'trace-box-1',
    })

    expect(result.correlation).toMatchObject({
      traceIds: ['trace-box-1'],
      orgIds: ['org-1'],
      boxIds: ['box-1', 'public-box-1'],
      runnerIds: ['runner-1'],
      machineIds: ['runner-1'],
      serviceNames: ['box-box-1'],
    })
    expect(result.boxes.map((box) => box.id)).toEqual(['box-1'])
    expect(result.boxes.map((box) => box.boxId)).toEqual(['public-box-1'])
    expect(result.runners.map((runner) => runner.id)).toEqual(['runner-1'])
    expect(result.machines.map((machine) => machine.host)).toEqual(['runner-1'])
    expect(cloudWatchLogReader.getRelatedLogs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        boxIds: ['box-1', 'public-box-1'],
      }),
    )
    expect(s3ObjectReader.listRelatedObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        boxIds: ['box-1', 'public-box-1'],
      }),
    )
  })

  it('does not narrow related logs by a correlated orgId when a specific box is targeted', async () => {
    const { service, clickhouseService, overviewService } = buildService({ configured: true })
    clickhouseService.query.mockImplementation(async (query: string) => {
      if (query.includes('FROM otel_traces') && query.includes('ResourceAttributes')) {
        return [
          {
            TraceId: 'trace-box-1',
            SpanId: 'span-1',
            ParentSpanId: '',
            SpanName: 'GET /version',
            Timestamp: '2026-06-05T00:00:00.000Z',
            Duration: 1_000_000,
            ServiceName: 'boxlite-api',
            ResourceAttributes: { 'boxlite.org_id': 'org-1' },
            SpanAttributes: { 'boxlite.org_id': 'org-1' },
            StatusCode: 'STATUS_CODE_OK',
            StatusMessage: '',
          },
        ]
      }
      if (query.includes('SELECT count() as count') && query.includes('FROM otel_logs')) {
        return [{ count: 1 }]
      }
      return []
    })
    overviewService.listBoxes.mockResolvedValue([
      {
        id: 'box-1',
        boxId: 'public-box-1',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-1',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
    ])

    await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      traceId: 'trace-box-1',
      boxId: 'box-1',
    })

    const relatedLogQueries = clickhouseService.query.mock.calls
      .map((call) => call[0] as string)
      .filter((sql) => sql.includes('FROM otel_logs') && !sql.includes('count() as count'))

    // org filter must NOT be AND-ed in: box self-logs carry ServiceName=box-<id> but
    // no dot-namespaced boxlite.org_id, so an org clause would silently drop them.
    expect(relatedLogQueries.length).toBeGreaterThan(0)
    for (const sql of relatedLogQueries) {
      expect(sql).not.toContain('boxlite.org_id')
    }
    // the box is still scoped via its service name match
    expect(relatedLogQueries.some((sql) => sql.includes('ServiceName = {boxServiceName:String}'))).toBe(true)
  })

  it('investigates one trace across telemetry, platform state, CloudWatch, S3, audit, and xLog', async () => {
    const { service, clickhouseService, overviewService, auditService, cloudWatchLogReader, s3ObjectReader } =
      buildService({
        configured: true,
        clickstackBaseUrl: 'https://clickstack.boxlite.dev/getting-started?chcServiceId=svc-1',
        clickstackDashboardUrl: 'https://clickstack.boxlite.dev/dashboards/dashboard-1?chcServiceId=svc-1',
        clickstackLogSourceId: 'logs-source-1',
        clickstackTraceSourceId: 'traces-source-1',
        clickstackMetricSourceId: 'metrics-source-1',
      })
    clickhouseService.query.mockImplementation(async (query: string) => {
      if (query.includes('FROM otel_traces') && query.includes('ResourceAttributes')) {
        return [
          {
            TraceId: 'trace-1',
            SpanId: 'span-1',
            ParentSpanId: '',
            SpanName: 'POST /api/boxes',
            Timestamp: '2026-06-05T00:00:00.000Z',
            Duration: 4_000_000,
            ServiceName: 'boxlite-api',
            ResourceAttributes: {
              'boxlite.layer': 'api',
              'boxlite.org_id': 'org-1',
              'boxlite.user_id': 'user-1',
              'boxlite.box_id': 'box-1',
              'boxlite.runner_id': 'runner-1',
              'boxlite.machine_id': 'machine-1',
            },
            SpanAttributes: {
              'boxlite.request_id': 'req-1',
              'boxlite.operation_id': 'op-1',
              'boxlite.execution_id': 'exec-1',
              'boxlite.job_id': 'job-1',
            },
            StatusCode: 'STATUS_CODE_OK',
            StatusMessage: '',
          },
        ]
      }
      if (query.includes('SELECT count() as count') && query.includes('FROM otel_logs')) {
        return [{ count: 1 }]
      }
      if (query.includes('FROM otel_logs')) {
        return [
          {
            Timestamp: '2026-06-05T00:00:01.000Z',
            Body: 'boxlite exec output',
            SeverityText: 'INFO',
            SeverityNumber: 9,
            ServiceName: 'boxlite-api',
            ResourceAttributes: {
              'boxlite.user_id': 'user-1',
              'boxlite.box_id': 'box-1',
              'boxlite.runner_id': 'runner-1',
            },
            LogAttributes: {
              'boxlite.request_id': 'req-1',
              'boxlite.execution_id': 'exec-1',
              'boxlite.job_id': 'job-1',
              'boxlite.stream': 'stdout',
              'boxlite.output': 'hello from exec\n',
            },
            TraceId: 'trace-1',
            SpanId: 'span-1',
          },
        ]
      }
      if (query.includes('FROM (') && query.includes('otel_metrics_gauge')) {
        return [
          {
            timestamp: '2026-06-05T00:01:00.000Z',
            MetricName: 'boxlite.runner.cpu.usage',
            layer: 'runner',
            value: 0.42,
          },
        ]
      }
      return []
    })
    overviewService.listBoxes.mockResolvedValue([
      {
        id: 'box-internal-1',
        boxId: 'box-1',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-1',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      {
        id: 'box-internal-2',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-2',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
    ])
    overviewService.listRunners.mockResolvedValue([{ id: 'runner-1', state: 'ready', draining: false }])
    overviewService.listMachines.mockResolvedValue([{ host: 'machine-1', region: 'us-east-1', boxes: 1 }])
    auditService.getAllLogs.mockResolvedValue({
      items: [
        {
          id: 'audit-1',
          actorId: 'user-1',
          actorEmail: 'admin@example.com',
          organizationId: 'org-1',
          action: 'create',
          targetType: 'box',
          targetId: 'box-1',
          createdAt: new Date('2026-06-05T00:00:02.000Z'),
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    })
    cloudWatchLogReader.getRelatedLogs.mockResolvedValue({
      logs: [
        {
          timestamp: '2026-06-05T00:00:03.000Z',
          body: 'runner attach stderr',
          severityText: 'ERROR',
          serviceName: 'cloudwatch:Api',
          resourceAttributes: {
            'boxlite.source': 'cloudwatch',
            'boxlite.layer': 'api',
            'boxlite.box_id': 'box-1',
          },
          logAttributes: {
            'boxlite.execution_id': 'exec-1',
            'boxlite.job_id': 'job-1',
            'boxlite.stream': 'stderr',
          },
          traceId: 'trace-1',
          spanId: 'span-1',
        },
      ],
      status: { source: 'cloudwatch', state: 'available', count: 1 },
    })
    s3ObjectReader.listRelatedObjects.mockResolvedValue({
      objects: [
        {
          bucket: 'bucket-1',
          key: 'box-1/xlog.txt',
          size: 12,
          matchedBy: 'box:box-1',
        },
      ],
      status: { source: 's3', state: 'available', count: 1 },
    })

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      traceId: 'trace-1',
    })

    expect(result.correlation).toMatchObject({
      traceIds: expect.arrayContaining(['trace-1']),
      orgIds: expect.arrayContaining(['org-1']),
      userIds: expect.arrayContaining(['user-1']),
      boxIds: expect.arrayContaining(['box-1', 'box-internal-1']),
      runnerIds: expect.arrayContaining(['runner-1']),
      machineIds: expect.arrayContaining(['machine-1']),
      requestIds: expect.arrayContaining(['req-1']),
      operationIds: expect.arrayContaining(['op-1']),
      executionIds: expect.arrayContaining(['exec-1']),
      jobIds: expect.arrayContaining(['job-1']),
      serviceNames: expect.arrayContaining(['boxlite-api', 'cloudwatch:Api']),
    })
    expect(result.traceSpans).toHaveLength(1)
    expect(result.logs).toHaveLength(2)
    expect(result.metrics.series).toHaveLength(1)
    expect(result.boxes.map((box) => box.id)).toEqual(['box-internal-1'])
    expect(result.runners.map((runner) => runner.id)).toEqual(['runner-1'])
    expect(result.machines.map((machine) => machine.host)).toEqual(['machine-1'])
    expect(result.auditLogs.map((log) => log.id)).toEqual(['audit-1'])
    expect(result.xlogs).toEqual([
      expect.objectContaining({
        source: 'clickhouse_logs',
        executionId: 'exec-1',
        jobId: 'job-1',
        stream: 'stdout',
        body: 'hello from exec\n',
      }),
      expect.objectContaining({
        source: 'cloudwatch_logs',
        executionId: 'exec-1',
        jobId: 'job-1',
        stream: 'stderr',
        body: 'runner attach stderr',
      }),
    ])
    expect(result.s3Objects).toEqual([
      expect.objectContaining({
        bucket: 'bucket-1',
        key: 'box-1/xlog.txt',
        matchedBy: 'box:box-1',
      }),
    ])
    expect(result.resource).toMatchObject({
      type: 'box',
      title: 'Box box-1',
      state: 'started',
    })
    expect(result.timeline.map((event) => event.source)).toEqual(
      expect.arrayContaining(['trace', 'log', 'audit', 'xlog']),
    )
    expect(result.commands.api).toContain('/admin/observability/investigate')
    expect(result.commands.aiAgentPrompt).toContain('X-BoxLite-Source=agent')
    expect(result.externalLinks.clickstack).toMatchObject({
      configured: true,
      missingSources: [],
      dashboardUrl: 'https://clickstack.boxlite.dev/dashboards/dashboard-1?chcServiceId=svc-1',
      query: expect.stringContaining('TraceId'),
    })
    expect(result.externalLinks.clickstack.logsUrl).toContain('https://clickstack.boxlite.dev/search')
    expect(result.externalLinks.clickstack.logsUrl).toContain('source=logs-source-1')
    expect(result.externalLinks.clickstack.logsUrl).toContain('whereLanguage=sql')
    expect(result.externalLinks.clickstack.logsUrl).toContain('chcServiceId=svc-1')
    expect(result.externalLinks.clickstack.logsUrl).not.toContain('view=logs')
    expect(result.externalLinks.clickstack.tracesUrl).toContain('source=traces-source-1')
    expect(result.externalLinks.clickstack.tracesUrl).toContain('traceId=trace-1')
    expect(result.externalLinks.clickstack.metricsUrl).toContain('https://clickstack.boxlite.dev/chart')
    if (!result.externalLinks.clickstack.logsUrl || !result.externalLinks.clickstack.tracesUrl) {
      throw new Error('Expected ClickStack logs and traces links')
    }
    const logsUrl = new URL(result.externalLinks.clickstack.logsUrl)
    expect(logsUrl.searchParams.get('from')).toBe(String(new Date('2026-06-05T00:00:00.000Z').getTime()))
    expect(logsUrl.searchParams.get('to')).toBe(String(new Date('2026-06-05T01:00:00.000Z').getTime()))
    expect(logsUrl.searchParams.get('isLive')).toBe('false')
    expect(logsUrl.searchParams.get('whereLanguage')).toBe('sql')
    expect(logsUrl.searchParams.get('where')).toContain("TraceId = 'trace-1'")
    expect(logsUrl.searchParams.get('where')).toContain("LogAttributes['boxlite.user_id'] = 'user-1'")
    expect(logsUrl.searchParams.get('where')).toContain("ResourceAttributes['boxlite.box_id'] = 'box-1'")
    expect(logsUrl.searchParams.get('where')).toContain("LogAttributes['boxlite.box_id'] = 'box-1'")
    const tracesUrl = new URL(result.externalLinks.clickstack.tracesUrl)
    expect(tracesUrl.searchParams.get('traceId')).toBe('trace-1')
    expect(tracesUrl.searchParams.get('whereLanguage')).toBe('sql')
    expect(tracesUrl.searchParams.get('where')).toContain("SpanAttributes['boxlite.user_id'] = 'user-1'")
    expect(tracesUrl.searchParams.get('where')).toContain("SpanAttributes['boxlite.box_id'] = 'box-1'")
    if (!result.externalLinks.clickstack.metricsUrl) {
      throw new Error('Expected ClickStack metrics link')
    }
    const metricsUrl = new URL(result.externalLinks.clickstack.metricsUrl)
    expect(metricsUrl.searchParams.get('from')).toBe(String(new Date('2026-06-05T00:00:00.000Z').getTime()))
    expect(metricsUrl.searchParams.get('to')).toBe(String(new Date('2026-06-05T01:00:00.000Z').getTime()))
    expect(metricsUrl.searchParams.get('isLive')).toBe('false')
    const metricsConfig = JSON.parse(metricsUrl.searchParams.get('config') ?? '{}')
    expect(metricsConfig).toMatchObject({
      source: 'metrics-source-1',
      displayType: 'line',
      granularity: 'auto',
      select: [expect.objectContaining({ aggFn: 'count' })],
    })
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'recover:box-internal-1', state: 'disabled' }),
        expect.objectContaining({ id: 'cordon:runner-1', state: 'enabled' }),
        expect.objectContaining({ id: 'drain:runner-1', state: 'enabled' }),
        expect.objectContaining({ id: 'resize:box-internal-1', state: 'request_only' }),
      ]),
    )
    expect(cloudWatchLogReader.getRelatedLogs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        traceIds: ['trace-1'],
        boxIds: ['box-1', 'box-internal-1'],
      }),
    )
    expect(s3ObjectReader.listRelatedObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        boxIds: ['box-1', 'box-internal-1'],
        executionIds: ['exec-1'],
      }),
    )
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'clickhouse', state: 'available', count: 3 }),
        expect.objectContaining({ source: 'cloudwatch', state: 'available', count: 1 }),
        expect.objectContaining({ source: 'postgres', state: 'available', count: 3 }),
        expect.objectContaining({ source: 'audit', state: 'available', count: 1 }),
        expect.objectContaining({ source: 's3', state: 'available', count: 1 }),
        expect.objectContaining({ source: 'xlog', state: 'available', count: 2 }),
        expect.objectContaining({ source: 'clickstack', state: 'available', count: 3 }),
      ]),
    )
  })

  it('matches prefixed admin observability audit target ids to related resources', async () => {
    const { service, overviewService, auditService } = buildService({ configured: true })

    overviewService.listBoxes.mockResolvedValue([
      {
        id: 'box-internal-1',
        boxId: 'box-public-1',
        organizationId: 'org-1',
        state: 'stopped',
        runnerId: 'runner-1',
        cpu: 1,
        memoryGiB: 1,
        createdAt: '2026-06-05T00:00:00.000Z',
        owner: { name: 'Brian Luo', email: 'brian.luo@polygala.ai', orgName: 'Personal', personal: true },
      },
    ])
    overviewService.listRunners.mockResolvedValue([{ id: 'runner-1', state: 'ready', draining: false }])
    overviewService.listMachines.mockResolvedValue([{ host: 'runner-1', region: 'us', boxes: 1 }])
    auditService.getAllLogs.mockResolvedValue({
      items: [
        {
          id: 'audit-prefixed-box',
          actorId: 'agent-1',
          actorEmail: 'agent@example.com',
          organizationId: 'admin-org',
          action: 'read',
          targetType: 'observability',
          targetId: 'boxId:box-public-1',
          source: 'agent',
          createdAt: new Date('2026-06-05T00:00:02.000Z'),
        },
        {
          id: 'audit-prefixed-box-internal',
          actorId: 'agent-1',
          actorEmail: 'agent@example.com',
          organizationId: 'admin-org',
          action: 'read',
          targetType: 'observability',
          targetId: 'boxId:box-internal-1',
          source: 'agent',
          createdAt: new Date('2026-06-05T00:00:03.000Z'),
        },
        {
          id: 'audit-other',
          actorId: 'agent-1',
          actorEmail: 'agent@example.com',
          organizationId: 'admin-org',
          action: 'read',
          targetType: 'observability',
          targetId: 'traceId:trace-other',
          source: 'agent',
          createdAt: new Date('2026-06-05T00:00:04.000Z'),
        },
      ],
      total: 3,
      page: 1,
      totalPages: 1,
    })

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      boxId: 'box-public-1',
      runnerId: 'runner-1',
      machineId: 'runner-1',
    })

    expect(result.auditLogs.map((log) => log.id)).toEqual(['audit-prefixed-box', 'audit-prefixed-box-internal'])
    expect(result.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'audit', state: 'available', count: 2 })]),
    )
  })

  it('summarizes explicit user and organization investigations without collapsing to the first box', async () => {
    const { service, overviewService, auditService } = buildService({
      configured: true,
      clickstackBaseUrl: 'https://clickstack.boxlite.dev/search?chcServiceId=svc-1',
      clickstackLogSourceId: 'logs-source-1',
      clickstackTraceSourceId: 'traces-source-1',
    })

    overviewService.listBoxes.mockResolvedValue([
      {
        id: 'box-internal-1',
        boxId: 'box-1',
        organizationId: 'org-1',
        state: 'started',
        runnerId: 'runner-1',
        cpu: 2,
        memoryGiB: 4,
        createdAt: '2026-06-05T00:00:00.000Z',
        owner: { userId: 'user-1', name: 'Brian Luo', email: 'brian@example.com', orgName: 'Personal', personal: true },
      },
    ])
    auditService.getAllLogs.mockResolvedValue({
      items: [
        {
          id: 'audit-user-actor',
          actorId: 'user-1',
          actorEmail: 'brian@example.com',
          organizationId: 'org-other',
          action: 'read',
          targetType: 'user',
          targetId: 'userId:user-1',
          createdAt: new Date('2026-06-05T00:00:02.000Z'),
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    })

    const userResult = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      orgId: 'org-1',
      userId: 'user-1',
    })
    const orgResult = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      orgId: 'org-1',
    })

    expect(userResult.resource).toMatchObject({
      type: 'user',
      title: 'User user-1',
      identifiers: expect.objectContaining({ userId: 'user-1', orgId: 'org-1' }),
    })
    expect(userResult.boxes.map((box) => box.id)).toEqual(['box-internal-1'])
    expect(userResult.auditLogs.map((log) => log.id)).toEqual(['audit-user-actor'])
    expect(userResult.externalLinks.clickstack.query).toContain('boxlite.user_id')
    expect(userResult.commands.api).toContain('userId=user-1')
    expect(orgResult.resource).toMatchObject({
      type: 'org',
      title: 'Organization org-1',
      identifiers: expect.objectContaining({ orgId: 'org-1' }),
    })
  })

  it('summarizes request and operation investigations as first-class resources', async () => {
    const { service } = buildService({ configured: true })

    const requestResult = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      requestId: 'req-1',
    })
    const operationResult = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      operationId: 'op-1',
    })

    expect(requestResult.resource).toMatchObject({ type: 'request', title: 'Request req-1' })
    expect(requestResult.externalLinks.clickstack.query).toContain('boxlite.request_id')
    expect(operationResult.resource).toMatchObject({ type: 'operation', title: 'Operation op-1' })
    expect(operationResult.externalLinks.clickstack.query).toContain('boxlite.operation_id')
  })

  it('does not report ClickStack as useful when ClickHouse has no matching OTel rows', async () => {
    const { service } = buildService({
      configured: true,
      clickstackBaseUrl: 'https://hyperdx.clickhouse.cloud/search?chcServiceId=svc-1',
      clickstackLogSourceId: 'logs-source-1',
      clickstackTraceSourceId: 'traces-source-1',
      clickstackMetricSourceId: 'metrics-source-1',
    })

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      traceId: 'trace-empty',
    })

    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'clickhouse',
          state: 'missing',
          count: 0,
          message:
            'ClickHouse is configured, but no matching OTel logs, traces, or metrics were found for this context',
        }),
        expect.objectContaining({
          source: 'clickstack',
          state: 'missing',
          count: 0,
          message:
            'ClickStack source ids are configured, but ClickHouse has no matching OTel rows for this investigation; the third-party page will be empty until collector ingestion writes data',
        }),
      ]),
    )
  })

  it('reports ClickStack as missing when source ids are not configured', async () => {
    const { service } = buildService({
      configured: false,
      clickstackBaseUrl: 'https://hyperdx.clickhouse.cloud/search?chcServiceId=svc-1',
    })

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      traceId: 'trace-1',
    })

    expect(result.externalLinks.clickstack).toMatchObject({
      configured: true,
      missingSources: ['logs', 'traces', 'metrics'],
      message:
        'ClickStack is reachable, but logs, traces, metrics source ids need to be configured for one-click queries',
      sourceSetup: [
        expect.objectContaining({
          kind: 'logs',
          envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID',
          database: 'otel',
          table: 'otel_logs',
          timestampColumn: 'Timestamp',
        }),
        expect.objectContaining({
          kind: 'traces',
          envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID',
          database: 'otel',
          table: 'otel_traces',
          timestampColumn: 'Timestamp',
        }),
        expect.objectContaining({
          kind: 'metrics',
          envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID',
          database: 'otel',
          timestampColumn: 'TimeUnix',
          metricTables: expect.objectContaining({
            gauge: 'otel_metrics_gauge',
            sum: 'otel_metrics_sum',
          }),
        }),
      ],
    })
    expect(result.externalLinks.clickstack.logsUrl).not.toContain('source=')
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'clickstack',
          state: 'missing',
          count: 0,
          message: result.externalLinks.clickstack.message,
        }),
      ]),
    )
  })

  it('uses valid ClickHouse SQL for ClickStack fallback queries without identifiers', async () => {
    const { service } = buildService({
      configured: false,
      clickstackBaseUrl: 'https://hyperdx.clickhouse.cloud/search?chcServiceId=svc-1',
      clickstackLogSourceId: 'logs-source-1',
    })

    const result = await service.investigate({
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
    })

    expect(result.externalLinks.clickstack.query).toBe("ServiceName != ''")
    expect(result.externalLinks.clickstack.logsUrl).toContain('ServiceName+%21%3D+%27%27')
    expect(result.externalLinks.clickstack.logsUrl).not.toContain('empty')
  })
})
