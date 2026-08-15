/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { BoxService } from '../../box/services/box.service'
import { LogEntryDto } from '../../box-telemetry/dto/log-entry.dto'
import { MetricDataPointDto, MetricsResponseDto, MetricSeriesDto } from '../../box-telemetry/dto/metrics-response.dto'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../../box-telemetry/dto/paginated-traces.dto'
import { TraceSpanDto } from '../../box-telemetry/dto/trace-span.dto'
import { TraceSummaryDto } from '../../box-telemetry/dto/trace-summary.dto'
import { ClickHouseService } from '../../clickhouse/clickhouse.service'
import {
  ALLOWED_BOX_METRICS,
  TenantLogsQueryDto,
  TenantMetricsQueryDto,
  TenantTelemetryRangeQueryDto,
  TenantTelemetrySource,
} from '../dto/tenant-observability-query.dto'

const MAX_QUERY_RANGE_MS = 24 * 60 * 60 * 1000
const MAX_QUERY_EXECUTION_SECONDS = 4
const ALL_SOURCES = Object.values(TenantTelemetrySource)

interface ClickHouseCountRow {
  count: number
}

interface ClickHouseLogRow {
  Timestamp: string
  Body: string
  SeverityText: string
  SeverityNumber: number
  ServiceName: string
  ResourceAttributes: Record<string, string>
  LogAttributes: Record<string, string>
  TraceId: string
  SpanId: string
}

interface ClickHouseTraceAggregateRow {
  TraceId: string
  startTime: string
  endTime: string
  spanCount: number
  rootSpanName: string
  totalDuration: number
  statusCode: string
}

interface ClickHouseSpanRow {
  TraceId: string
  SpanId: string
  ParentSpanId: string
  SpanName: string
  ServiceName: string
  Timestamp: string
  Duration: number
  SpanAttributes: Record<string, string>
  StatusCode: string
  StatusMessage: string
  source: string
}

interface ClickHouseMetricRow {
  timestamp: string
  MetricName: string
  value: number
}

interface QueryParts {
  where: string
  params: Record<string, unknown>
}

@Injectable()
export class TenantObservabilityService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly boxService: BoxService,
  ) {}

  async getLogs(organizationId: string, query: TenantLogsQueryDto): Promise<PaginatedLogsDto> {
    this.assertConfigured()
    this.assertRange(query.from, query.to)
    await this.assertBoxAccess(organizationId, query.boxId)

    const { where, params } = this.buildWhere('logs', organizationId, query)
    const page = query.page ?? 1
    const limit = query.limit ?? 50
    const offset = (page - 1) * limit
    Object.assign(params, { limit, offset })

    const [countRows, rows] = await Promise.all([
      this.clickhouse.query<ClickHouseCountRow>(`SELECT count() AS count FROM otel_logs WHERE ${where}`, params, {
        maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS,
      }),
      this.clickhouse.query<ClickHouseLogRow>(
        `SELECT Timestamp, Body, SeverityText, SeverityNumber, ServiceName,
                ResourceAttributes, LogAttributes, TraceId, SpanId
         FROM otel_logs
         WHERE ${where}
         ORDER BY Timestamp DESC, TraceId DESC, SpanId DESC
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        params,
        { maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS },
      ),
    ])

    const total = Number(countRows[0]?.count ?? 0)
    const items: LogEntryDto[] = rows.map((row) => ({
      timestamp: row.Timestamp,
      body: row.Body,
      severityText: row.SeverityText,
      severityNumber: row.SeverityNumber,
      serviceName: row.ServiceName,
      resourceAttributes: row.ResourceAttributes || {},
      logAttributes: row.LogAttributes || {},
      traceId: row.TraceId || undefined,
      spanId: row.SpanId || undefined,
    }))

    return { items, total, page, totalPages: Math.ceil(total / limit) }
  }

  async getTraces(organizationId: string, query: TenantTelemetryRangeQueryDto): Promise<PaginatedTracesDto> {
    this.assertConfigured()
    this.assertRange(query.from, query.to)
    await this.assertBoxAccess(organizationId, query.boxId)

    const { where, params } = this.buildWhere('traces', organizationId, query)
    const page = query.page ?? 1
    const limit = query.limit ?? 50
    const offset = (page - 1) * limit
    Object.assign(params, { limit, offset })

    const [countRows, rows] = await Promise.all([
      this.clickhouse.query<ClickHouseCountRow>(
        `SELECT count(DISTINCT TraceId) AS count FROM otel_traces WHERE ${where}`,
        params,
        { maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS },
      ),
      this.clickhouse.query<ClickHouseTraceAggregateRow>(
        `SELECT TraceId,
                min(Timestamp) AS startTime,
                max(Timestamp) AS endTime,
                count() AS spanCount,
                coalesce(nullIf(argMinIf(SpanName, Timestamp, ParentSpanId = ''), ''), argMin(SpanName, Timestamp)) AS rootSpanName,
                max(Duration) AS totalDuration,
                any(StatusCode) AS statusCode
         FROM otel_traces
         WHERE ${where}
         GROUP BY TraceId
         ORDER BY startTime DESC, TraceId DESC
         LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        params,
        { maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS },
      ),
    ])

    const total = Number(countRows[0]?.count ?? 0)
    const items: TraceSummaryDto[] = rows.map((row) => ({
      traceId: row.TraceId,
      rootSpanName: row.rootSpanName,
      startTime: row.startTime,
      endTime: row.endTime,
      durationMs: Number(row.totalDuration) / 1_000_000,
      spanCount: Number(row.spanCount),
      statusCode: row.statusCode || undefined,
    }))

    return { items, total, page, totalPages: Math.ceil(total / limit) }
  }

  async getTraceSpans(organizationId: string, traceId: string, boxId?: string): Promise<TraceSpanDto[]> {
    this.assertConfigured()
    await this.assertBoxAccess(organizationId, boxId)

    const query: TenantTelemetryRangeQueryDto = {
      from: new Date(Date.now() - MAX_QUERY_RANGE_MS).toISOString(),
      to: new Date().toISOString(),
      page: 1,
      limit: 100,
      boxId,
    }
    const { where: tenantWhere, params } = this.buildWhere('traces', organizationId, query, false)
    params.traceId = traceId.toLowerCase()

    const rows = await this.clickhouse.query<ClickHouseSpanRow>(
      `SELECT TraceId, SpanId, ParentSpanId, SpanName, ServiceName, Timestamp, Duration,
              SpanAttributes, StatusCode, StatusMessage, ${this.sourceExpression('traces')} AS source
       FROM otel_traces
       WHERE TraceId = {traceId:String} AND ${tenantWhere}
       ORDER BY Timestamp ASC, SpanId ASC
       LIMIT 1000`,
      params,
      { maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS },
    )

    if (rows.length === 0) {
      throw new NotFoundException('Trace not found')
    }

    return rows.map((row) => ({
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId || undefined,
      spanName: row.SpanName,
      serviceName: row.ServiceName,
      layer: row.source,
      timestamp: row.Timestamp,
      durationNs: Number(row.Duration),
      spanAttributes: row.SpanAttributes || {},
      statusCode: row.StatusCode || undefined,
      statusMessage: row.StatusMessage || undefined,
    }))
  }

  async getMetrics(organizationId: string, query: TenantMetricsQueryDto): Promise<MetricsResponseDto> {
    this.assertConfigured()
    this.assertRange(query.from, query.to)
    await this.assertBoxAccess(organizationId, query.boxId)

    const requestedMetrics = query.metricNames?.length ? query.metricNames : Array.from(ALLOWED_BOX_METRICS)
    if (requestedMetrics.some((metric) => !ALLOWED_BOX_METRICS.has(metric))) {
      throw new BadRequestException('One or more metric names are not supported')
    }

    const tenantExpression = this.tenantExpression('metrics')
    const boxExpression = this.attributeExpression('metrics', 'boxlite.box.id')
    const rows = await this.clickhouse.query<ClickHouseMetricRow>(
      `SELECT toStartOfInterval(TimeUnix, INTERVAL 1 MINUTE) AS timestamp,
              MetricName,
              avg(Value) AS value
       FROM otel_metrics_gauge
       WHERE TimeUnix >= {from:DateTime64}
         AND TimeUnix <= {to:DateTime64}
         AND MetricName IN ({metricNames:Array(String)})
         AND ${tenantExpression} = {organizationId:String}
         AND ${boxExpression} = {boxId:String}
       GROUP BY timestamp, MetricName
       ORDER BY timestamp ASC`,
      {
        from: new Date(query.from),
        to: new Date(query.to),
        metricNames: requestedMetrics,
        organizationId,
        boxId: query.boxId,
      },
      { maxExecutionTimeSeconds: MAX_QUERY_EXECUTION_SECONDS },
    )

    const seriesMap = new Map<string, MetricDataPointDto[]>()
    for (const row of rows) {
      const points = seriesMap.get(row.MetricName) ?? []
      points.push({ timestamp: row.timestamp, value: Number(row.value) })
      seriesMap.set(row.MetricName, points)
    }
    const series: MetricSeriesDto[] = Array.from(seriesMap, ([metricName, dataPoints]) => ({ metricName, dataPoints }))
    return { series }
  }

  private buildWhere(
    signal: 'logs' | 'traces',
    organizationId: string,
    query: TenantTelemetryRangeQueryDto | TenantLogsQueryDto,
    includeTime = true,
  ): QueryParts {
    const tenantExpression = this.tenantExpression(signal)
    const sourceExpression = this.sourceExpression(signal)
    const boxExpression = this.attributeExpression(signal, 'boxlite.box.id')
    const params: Record<string, unknown> = {
      organizationId,
      sources: query.sources?.length ? query.sources : ALL_SOURCES,
    }

    const clauses = [`${tenantExpression} = {organizationId:String}`]

    if (includeTime) {
      clauses.push(`${signal === 'logs' ? 'Timestamp' : 'Timestamp'} >= {from:DateTime64}`)
      clauses.push(`${signal === 'logs' ? 'Timestamp' : 'Timestamp'} <= {to:DateTime64}`)
      params.from = new Date(query.from)
      params.to = new Date(query.to)
    }

    clauses.push(`${sourceExpression} IN ({sources:Array(String)})`)

    if (query.boxId) {
      params.boxId = query.boxId
      clauses.push(`${boxExpression} = {boxId:String}`)
    }
    if (query.runnerId) {
      params.runnerId = query.runnerId
      clauses.push(`${this.attributeExpression(signal, 'boxlite.runner.id')} = {runnerId:String}`)
    }
    if (query.jobId) {
      params.jobId = query.jobId
      clauses.push(`${this.attributeExpression(signal, 'boxlite.job.id')} = {jobId:String}`)
    }

    if ('severities' in query && query.severities?.length) {
      params.severities = query.severities
      clauses.push('SeverityText IN ({severities:Array(String)})')
    }
    if ('search' in query && query.search) {
      params.search = query.search
      clauses.push('positionCaseInsensitiveUTF8(Body, {search:String}) > 0')
    }
    if ('traceId' in query && query.traceId) {
      params.traceId = query.traceId.toLowerCase()
      clauses.push('TraceId = {traceId:String}')
    }

    return { where: clauses.join('\n AND '), params }
  }

  private tenantExpression(signal: 'logs' | 'traces' | 'metrics'): string {
    return this.attributeExpression(signal, 'boxlite.organization.id')
  }

  private attributeExpression(signal: 'logs' | 'traces' | 'metrics', name: string): string {
    const signalAttributes = signal === 'logs' ? 'LogAttributes' : signal === 'traces' ? 'SpanAttributes' : 'Attributes'
    return `coalesce(nullIf(${signalAttributes}['${name}'], ''), nullIf(ResourceAttributes['${name}'], ''), '')`
  }

  private sourceExpression(signal: 'logs' | 'traces'): string {
    const source = this.attributeExpression(signal, 'boxlite.source')
    return `coalesce(nullIf(${source}, ''), multiIf(
      ServiceName = 'boxlite-api', 'api',
      ServiceName = 'boxlite-worker', 'worker',
      ServiceName = 'boxlite-runner', 'runner',
      startsWith(ServiceName, 'box-'), 'box',
      'unknown'))`
  }

  private assertConfigured(): void {
    if (!this.clickhouse.isConfigured()) {
      throw new ServiceUnavailableException('Tenant observability is not configured')
    }
  }

  private assertRange(from: string, to: string): void {
    const start = Date.parse(from)
    const end = Date.parse(to)
    if (start > end) {
      throw new BadRequestException('from must be before to')
    }
    if (end - start > MAX_QUERY_RANGE_MS) {
      throw new BadRequestException('Tenant observability searches are limited to 24 hours')
    }
  }

  private async assertBoxAccess(organizationId: string, boxId?: string): Promise<void> {
    if (!boxId) {
      return
    }
    try {
      const boxOrganizationId = await this.boxService.getOrganizationId(boxId, organizationId)
      if (boxOrganizationId !== organizationId) {
        throw new NotFoundException('Box not found')
      }
    } catch {
      throw new NotFoundException('Box not found')
    }
  }
}
