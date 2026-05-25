/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { ClickHouseService } from '../../clickhouse/clickhouse.service'
import { LogEntryDto } from '../dto/log-entry.dto'
import { PaginatedLogsDto } from '../dto/paginated-logs.dto'
import { TraceSummaryDto } from '../dto/trace-summary.dto'
import { TraceSpanDto } from '../dto/trace-span.dto'
import { PaginatedTracesDto } from '../dto/paginated-traces.dto'
import { MetricsResponseDto, MetricSeriesDto, MetricDataPointDto } from '../dto/metrics-response.dto'

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
  Timestamp: string
  Duration: number
  SpanAttributes: Record<string, string>
  StatusCode: string
  StatusMessage: string
}

interface ClickHouseMetricRow {
  timestamp: string
  MetricName: string
  value: number
}

interface ClickHouseCountRow {
  count: number
}

const PLATFORM_TELEMETRY_SERVICE_NAME = 'boxlite-api'

@Injectable()
export class SandboxTelemetryService {
  private readonly logger = new Logger(SandboxTelemetryService.name)

  constructor(private readonly clickhouseService: ClickHouseService) {}

  private getServiceName(sandboxId: string): string {
    void sandboxId
    // POL-14 Phase3 Plan B: internal admin shows PLATFORM telemetry (API/runner),
    // not per-sandbox daemon telemetry (no daemon emit in Plan B). The panel is
    // platform-scoped; sandboxId is ignored.
    return PLATFORM_TELEMETRY_SERVICE_NAME
  }

  isConfigured(): boolean {
    return this.clickhouseService.isConfigured()
  }

  async getLogs(
    sandboxId: string,
    from: string,
    to: string,
    page: number,
    limit: number,
    severities?: string[],
    search?: string,
  ): Promise<PaginatedLogsDto> {
    const serviceName = this.getServiceName(sandboxId)
    return this.getLogsForService(serviceName, from, to, page, limit, severities, search)
  }

  async getPlatformLogs(
    from: string,
    to: string,
    page: number,
    limit: number,
    severities?: string[],
    search?: string,
  ): Promise<PaginatedLogsDto> {
    return this.getLogsForService(PLATFORM_TELEMETRY_SERVICE_NAME, from, to, page, limit, severities, search)
  }

  private async getLogsForService(
    serviceName: string,
    from: string,
    to: string,
    page: number,
    limit: number,
    severities?: string[],
    search?: string,
  ): Promise<PaginatedLogsDto> {
    const offset = (page - 1) * limit

    // Build WHERE clause for optional filters
    let whereClause = `ServiceName = {serviceName:String}
      AND Timestamp >= {from:DateTime64}
      AND Timestamp <= {to:DateTime64}`

    if (severities && severities.length > 0) {
      whereClause += ` AND SeverityText IN ({severities:Array(String)})`
    }

    if (search) {
      whereClause += ` AND Body ILIKE {search:String}`
    }

    const params: Record<string, unknown> = {
      serviceName,
      from: new Date(from),
      to: new Date(to),
      limit,
      offset,
    }

    if (severities && severities.length > 0) {
      params.severities = severities
    }

    if (search) {
      params.search = `%${search}%`
    }

    // Get total count
    const countQuery = `
      SELECT count() as count
      FROM otel_logs
      WHERE ${whereClause}
    `
    const countResult = await this.clickhouseService.query<ClickHouseCountRow>(countQuery, params)
    const total = countResult[0]?.count || 0

    // Get paginated logs
    const logsQuery = `
      SELECT Timestamp, Body, SeverityText, SeverityNumber, ServiceName,
             ResourceAttributes, LogAttributes, TraceId, SpanId
      FROM otel_logs
      WHERE ${whereClause}
      ORDER BY Timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `
    const rows = await this.clickhouseService.query<ClickHouseLogRow>(logsQuery, params)

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

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    }
  }

  async getTraces(
    sandboxId: string,
    from: string,
    to: string,
    page: number,
    limit: number,
  ): Promise<PaginatedTracesDto> {
    const serviceName = this.getServiceName(sandboxId)
    return this.getTracesForService(serviceName, from, to, page, limit)
  }

  async getPlatformTraces(from: string, to: string, page: number, limit: number): Promise<PaginatedTracesDto> {
    return this.getTracesForService(PLATFORM_TELEMETRY_SERVICE_NAME, from, to, page, limit)
  }

  private async getTracesForService(
    serviceName: string,
    from: string,
    to: string,
    page: number,
    limit: number,
  ): Promise<PaginatedTracesDto> {
    const offset = (page - 1) * limit

    const params = {
      serviceName,
      from: new Date(from),
      to: new Date(to),
      limit,
      offset,
    }

    // Get total count of unique traces
    const countQuery = `
      SELECT count(DISTINCT TraceId) as count
      FROM otel_traces
      WHERE ServiceName = {serviceName:String}
        AND Timestamp >= {from:DateTime64}
        AND Timestamp <= {to:DateTime64}
    `
    const countResult = await this.clickhouseService.query<ClickHouseCountRow>(countQuery, params)
    const total = countResult[0]?.count || 0

    // Get aggregated trace data
    const tracesQuery = `
      SELECT
        TraceId,
        min(Timestamp) as startTime,
        max(Timestamp) as endTime,
        count() as spanCount,
        argMinIf(SpanName, Timestamp, ParentSpanId = '') as rootSpanName,
        max(Duration) as totalDuration,
        any(StatusCode) as statusCode
      FROM otel_traces
      WHERE ServiceName = {serviceName:String}
        AND Timestamp >= {from:DateTime64}
        AND Timestamp <= {to:DateTime64}
      GROUP BY TraceId
      ORDER BY startTime DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `
    const rows = await this.clickhouseService.query<ClickHouseTraceAggregateRow>(tracesQuery, params)

    const items: TraceSummaryDto[] = rows.map((row) => ({
      traceId: row.TraceId,
      rootSpanName: row.rootSpanName,
      startTime: row.startTime,
      endTime: row.endTime,
      durationMs: row.totalDuration / 1_000_000, // Convert nanoseconds to milliseconds
      spanCount: row.spanCount,
      statusCode: row.statusCode || undefined,
    }))

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    }
  }

  async getTraceSpans(sandboxId: string, traceId: string): Promise<TraceSpanDto[]> {
    const serviceName = this.getServiceName(sandboxId)
    return this.getTraceSpansForService(serviceName, traceId)
  }

  async getPlatformTraceSpans(traceId: string): Promise<TraceSpanDto[]> {
    return this.getTraceSpansForService(PLATFORM_TELEMETRY_SERVICE_NAME, traceId)
  }

  private async getTraceSpansForService(serviceName: string, traceId: string): Promise<TraceSpanDto[]> {
    const query = `
      SELECT TraceId, SpanId, ParentSpanId, SpanName, Timestamp, Duration,
             SpanAttributes, StatusCode, StatusMessage
      FROM otel_traces
      WHERE TraceId = {traceId:String}
        AND ServiceName = {serviceName:String}
      ORDER BY Timestamp ASC
    `

    const rows = await this.clickhouseService.query<ClickHouseSpanRow>(query, { traceId, serviceName })

    return rows.map((row) => ({
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId || undefined,
      spanName: row.SpanName,
      timestamp: row.Timestamp,
      durationNs: row.Duration,
      spanAttributes: row.SpanAttributes || {},
      statusCode: row.StatusCode || undefined,
      statusMessage: row.StatusMessage || undefined,
    }))
  }

  async getMetrics(sandboxId: string, from: string, to: string, metricNames?: string[]): Promise<MetricsResponseDto> {
    const serviceName = this.getServiceName(sandboxId)
    return this.getMetricsForService(serviceName, from, to, metricNames)
  }

  async getPlatformMetrics(from: string, to: string, metricNames?: string[]): Promise<MetricsResponseDto> {
    return this.getMetricsForService(PLATFORM_TELEMETRY_SERVICE_NAME, from, to, metricNames)
  }

  private async getMetricsForService(
    serviceName: string,
    from: string,
    to: string,
    metricNames?: string[],
  ): Promise<MetricsResponseDto> {
    let whereClause = `ServiceName = {serviceName:String}
      AND TimeUnix >= {from:DateTime64}
      AND TimeUnix <= {to:DateTime64}`

    const params: Record<string, unknown> = {
      serviceName,
      from: new Date(from),
      to: new Date(to),
    }

    if (metricNames && metricNames.length > 0) {
      whereClause += ` AND MetricName IN ({metricNames:Array(String)})`
      params.metricNames = metricNames
    }

    // Query platform metrics with 1-minute intervals. Histograms expose their
    // per-minute mean for now, preserving the existing MetricsResponseDto shape.
    const gaugeQuery = `
      SELECT
        toStartOfInterval(TimeUnix, INTERVAL 1 MINUTE) as timestamp,
        MetricName,
        avg(Value) as value
      FROM otel_metrics_gauge
      WHERE ${whereClause}
      GROUP BY timestamp, MetricName
      ORDER BY timestamp ASC
    `

    const sumQuery = `
      SELECT
        toStartOfInterval(TimeUnix, INTERVAL 1 MINUTE) as timestamp,
        MetricName,
        avg(Value) as value
      FROM otel_metrics_sum
      WHERE ${whereClause}
      GROUP BY timestamp, MetricName
      ORDER BY timestamp ASC
    `

    const histogramQuery = `
      SELECT
        toStartOfInterval(TimeUnix, INTERVAL 1 MINUTE) as timestamp,
        MetricName,
        sum(Sum) / nullIf(sum(Count), 0) as value
      FROM otel_metrics_histogram
      WHERE ${whereClause}
      GROUP BY timestamp, MetricName
      HAVING isNotNull(value)
      ORDER BY timestamp ASC
    `

    const metricRows = (
      await Promise.all([
        this.clickhouseService.query<ClickHouseMetricRow>(gaugeQuery, params),
        this.clickhouseService.query<ClickHouseMetricRow>(sumQuery, params),
        this.clickhouseService.query<ClickHouseMetricRow>(histogramQuery, params),
      ])
    ).flat()

    // Group by metric name
    const seriesMap = new Map<string, MetricDataPointDto[]>()
    for (const row of metricRows) {
      if (!seriesMap.has(row.MetricName)) {
        seriesMap.set(row.MetricName, [])
      }
      const dataPoints = seriesMap.get(row.MetricName)
      dataPoints?.push({
        timestamp: row.timestamp,
        value: Number(row.value),
      })
    }

    const series: MetricSeriesDto[] = Array.from(seriesMap.entries()).map(([metricName, dataPoints]) => ({
      metricName,
      dataPoints,
    }))

    return { series }
  }
}
