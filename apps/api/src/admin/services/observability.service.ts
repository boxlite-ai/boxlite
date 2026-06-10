/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { ClickHouseService } from '../../clickhouse/clickhouse.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { LogEntryDto } from '../../box-telemetry/dto/log-entry.dto'
import {
  MetricsResponseDto,
  MetricDataPointDto,
  MetricSeriesDto,
} from '../../box-telemetry/dto/metrics-response.dto'
import { PaginatedLogsDto } from '../../box-telemetry/dto/paginated-logs.dto'
import { PaginatedTracesDto } from '../../box-telemetry/dto/paginated-traces.dto'
import { TraceSpanDto } from '../../box-telemetry/dto/trace-span.dto'
import { TraceSummaryDto } from '../../box-telemetry/dto/trace-summary.dto'
import { AdminBoxItemDto, AdminMachineItemDto, AdminRunnerItemDto } from '../dto/admin-overview.dto'
import {
  AdminObservabilityAuditLogDto,
  AdminObservabilityClickStackSourceSetupDto,
  AdminObservabilityCommandsDto,
  AdminObservabilityCorrelationDto,
  AdminObservabilityExternalLinksDto,
  AdminObservabilityInvestigateQueryParamsDto,
  AdminObservabilityInvestigateResponseDto,
  AdminObservabilityOperationDto,
  AdminObservabilityResourceSummaryDto,
  AdminObservabilityS3ObjectDto,
  AdminObservabilitySourceStatusDto,
  AdminObservabilityTimelineEventDto,
  AdminObservabilityXLogDto,
} from '../dto/observability-investigate.dto'
import {
  AdminObservabilityLogsQueryParamsDto,
  AdminObservabilityMetricsQueryParamsDto,
  AdminObservabilityQueryParamsDto,
  OBSERVABILITY_LAYERS,
  ObservabilityLayer,
} from '../dto/observability-query.dto'
import {
  AdminObservabilityLayerSignalsDto,
  AdminObservabilityLayerStatusDto,
  AdminObservabilityStatusDto,
  ObservabilityState,
} from '../dto/observability-status.dto'

export const ADMIN_AUDIT_LOG_READER = 'ADMIN_AUDIT_LOG_READER'
export const ADMIN_PLATFORM_STATE_READER = 'ADMIN_PLATFORM_STATE_READER'
export const ADMIN_CLOUDWATCH_LOG_READER = 'ADMIN_CLOUDWATCH_LOG_READER'
export const ADMIN_S3_OBJECT_READER = 'ADMIN_S3_OBJECT_READER'

interface AdminAuditLogLike {
  id: string
  actorId: string
  actorEmail: string
  organizationId?: string
  action: string
  targetType?: string
  targetId?: string
  statusCode?: number
  errorMessage?: string
  source?: string
  metadata?: Record<string, unknown>
  createdAt: Date
}

interface AdminAuditLogReader {
  getAllLogs(
    page?: number,
    limit?: number,
    filters?: { from?: Date; to?: Date },
    nextToken?: string,
  ): Promise<{ items: AdminAuditLogLike[]; total: number; page: number; totalPages: number; nextToken?: string }>
}

interface AdminPlatformStateReader {
  listBoxes(): Promise<AdminBoxItemDto[]>
  listRunners(): Promise<AdminRunnerItemDto[]>
  listMachines(): Promise<AdminMachineItemDto[]>
}

interface AdminCloudWatchLogReader {
  getRelatedLogs(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ logs: LogEntryDto[]; status: AdminObservabilitySourceStatusDto }>
}

interface AdminS3ObjectReader {
  listRelatedObjects(
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ objects: AdminObservabilityS3ObjectDto[]; status: AdminObservabilitySourceStatusDto }>
}

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
  Timestamp: string
  Duration: number
  ServiceName?: string
  ResourceAttributes?: Record<string, string>
  SpanAttributes: Record<string, string>
  StatusCode: string
  StatusMessage: string
}

interface ClickHouseMetricRow {
  timestamp: string
  MetricName: string
  layer: ObservabilityLayer | ''
  value: number
}

interface StatusRow {
  layer: ObservabilityLayer
  signal: keyof AdminObservabilityLayerSignalsDto
  lastSeenMs: number | string
}

const SIGNALS: Array<keyof AdminObservabilityLayerSignalsDto> = ['logs', 'traces', 'metrics']
const STALE_AFTER_MS = 15 * 60 * 1000
const DEFAULT_OBSERVABILITY_LOOKBACK_MS = 60 * 60 * 1000
const LAYER_EXPRESSION_SQL = `
  multiIf(
    ResourceAttributes['boxlite.layer'] != '', ResourceAttributes['boxlite.layer'],
    ServiceName = 'boxlite-api', 'api',
    ServiceName = 'boxlite-runner', 'runner',
    ServiceName = 'boxlite-runner-host', 'ec2_host',
    startsWith(ServiceName, 'box-'), 'box',
    ''
  )
`

// TS mirror of LAYER_EXPRESSION_SQL — keep both in sync. Lets consumers (esp. AI
// agents) attribute a single span to its emitting layer without re-querying.
function resolveSpanLayer(serviceName?: string, resourceAttributes?: Record<string, string>): string {
  const explicit = resourceAttributes?.['boxlite.layer']
  if (explicit) return explicit
  if (!serviceName) return ''
  if (serviceName === 'boxlite-api') return 'api'
  if (serviceName === 'boxlite-runner') return 'runner'
  if (serviceName === 'boxlite-runner-host') return 'ec2_host'
  if (serviceName.startsWith('box-')) return 'box'
  return ''
}
const SCALAR_METRICS_SOURCE_SQL = `
  SELECT TimeUnix, MetricName, Value, ServiceName, ResourceAttributes FROM otel_metrics_gauge
  UNION ALL
  SELECT TimeUnix, MetricName, Value, ServiceName, ResourceAttributes FROM otel_metrics_sum
`

@Injectable()
export class AdminObservabilityService {
  constructor(
    private readonly clickhouseService: ClickHouseService,
    private readonly configService: TypedConfigService,
    @Inject(ADMIN_PLATFORM_STATE_READER) private readonly overviewService: AdminPlatformStateReader,
    @Inject(ADMIN_AUDIT_LOG_READER) private readonly auditService: AdminAuditLogReader,
    @Inject(ADMIN_CLOUDWATCH_LOG_READER) private readonly cloudWatchLogReader: AdminCloudWatchLogReader,
    @Inject(ADMIN_S3_OBJECT_READER) private readonly s3ObjectReader: AdminS3ObjectReader,
  ) {}

  async getStatus(): Promise<AdminObservabilityStatusDto> {
    if (!this.clickhouseService.isConfigured()) {
      return {
        backend: {
          configured: false,
          state: 'missing',
          message: 'ClickHouse/ClickStack is not configured',
        },
        layers: this.buildMissingLayers(),
      }
    }

    try {
      const rows = await this.clickhouseService.query<StatusRow>(`
	        SELECT layer, signal, max(lastSeenMs) AS lastSeenMs
	        FROM (
	          SELECT ${LAYER_EXPRESSION_SQL} AS layer, 'logs' AS signal, toUnixTimestamp64Milli(max(Timestamp)) AS lastSeenMs
	          FROM otel_logs
	          WHERE layer != ''
	          GROUP BY layer
	          UNION ALL
	          SELECT ${LAYER_EXPRESSION_SQL} AS layer, 'traces' AS signal, toUnixTimestamp64Milli(max(Timestamp)) AS lastSeenMs
	          FROM otel_traces
	          WHERE layer != ''
	          GROUP BY layer
	          UNION ALL
	          SELECT ${LAYER_EXPRESSION_SQL} AS layer, 'metrics' AS signal, toUnixTimestamp64Milli(max(TimeUnix)) AS lastSeenMs
	          FROM (
	            SELECT TimeUnix, ServiceName, ResourceAttributes FROM otel_metrics_gauge
	            UNION ALL
	            SELECT TimeUnix, ServiceName, ResourceAttributes FROM otel_metrics_sum
	            UNION ALL
	            SELECT TimeUnix, ServiceName, ResourceAttributes FROM otel_metrics_summary
	            UNION ALL
	            SELECT TimeUnix, ServiceName, ResourceAttributes FROM otel_metrics_histogram
	            UNION ALL
	            SELECT TimeUnix, ServiceName, ResourceAttributes FROM otel_metrics_exponential_histogram
	          )
	          WHERE layer != ''
	          GROUP BY layer
	        )
	        GROUP BY layer, signal
      `)

      const layers = this.buildConfiguredLayers(rows)
      const hasObservedTelemetry = layers.some((layer) => Boolean(layer.lastSeen))
      return {
        backend: {
          configured: true,
          state: layers.some((layer) => layer.state === 'receiving') ? 'receiving' : 'configured',
          message: hasObservedTelemetry
            ? undefined
            : 'ClickHouse is configured, but no OTel logs, traces, or metrics have been observed yet',
        },
        layers,
      }
    } catch (error) {
      return {
        backend: {
          configured: true,
          state: 'error',
          message: error instanceof Error ? error.message : 'ClickHouse status query failed',
        },
        layers: OBSERVABILITY_LAYERS.map((layer) => ({
          layer,
          state: 'error',
          signals: { logs: 'error', traces: 'error', metrics: 'error' },
        })),
      }
    }
  }

  async getLogs(query: AdminObservabilityLogsQueryParamsDto): Promise<PaginatedLogsDto> {
    this.assertConfigured()
    const params = this.buildBaseParams(query)
    const whereClause = this.buildWhereClause('Timestamp', query, params, { eventAttributesColumn: 'LogAttributes' })

    if (query.severities && query.severities.length > 0) {
      whereClause.push('lower(SeverityText) IN ({severities:Array(String)})')
      params.severities = query.severities.map((severity) => severity.toLowerCase())
    }
    if (query.search) {
      whereClause.push('Body ILIKE {search:String}')
      params.search = `%${query.search}%`
    }
    this.pushTraceIdFilter(whereClause, params, query.traceId)
    this.pushAttributeFilter(whereClause, params, 'LogAttributes', 'boxlite.user_id', 'userId', query.userId)
    this.pushAttributeFilter(whereClause, params, 'LogAttributes', 'boxlite.request_id', 'requestId', query.requestId)
    this.pushAttributeFilter(
      whereClause,
      params,
      'LogAttributes',
      'boxlite.operation_id',
      'operationId',
      query.operationId,
    )
    this.pushAttributeFilter(
      whereClause,
      params,
      'LogAttributes',
      'boxlite.execution_id',
      'executionId',
      query.executionId,
    )
    this.pushAttributeFilter(whereClause, params, 'LogAttributes', 'boxlite.job_id', 'jobId', query.jobId)

    const whereSql = whereClause.join('\n        AND ')
    const countResult = await this.clickhouseService.query<ClickHouseCountRow>(
      `
      SELECT count() as count
      FROM otel_logs
      WHERE ${whereSql}
    `,
      params,
    )
    const total = countResult[0]?.count || 0

    const rows = await this.clickhouseService.query<ClickHouseLogRow>(
      `
      SELECT Timestamp, Body, SeverityText, SeverityNumber, ServiceName,
             ResourceAttributes, LogAttributes, TraceId, SpanId
      FROM otel_logs
      WHERE ${whereSql}
      ORDER BY Timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
      params,
    )

    return {
      items: rows.map((row) => ({
        timestamp: row.Timestamp,
        body: row.Body,
        severityText: row.SeverityText,
        severityNumber: row.SeverityNumber,
        serviceName: row.ServiceName,
        resourceAttributes: row.ResourceAttributes || {},
        logAttributes: row.LogAttributes || {},
        traceId: row.TraceId || undefined,
        spanId: row.SpanId || undefined,
      })) as LogEntryDto[],
      total,
      page: query.page ?? 1,
      totalPages: Math.ceil(total / (query.limit ?? 100)),
    }
  }

  async getTraces(query: AdminObservabilityQueryParamsDto): Promise<PaginatedTracesDto> {
    this.assertConfigured()
    const params = this.buildBaseParams(query)
    const whereClause = this.buildWhereClause('Timestamp', query, params, { eventAttributesColumn: 'SpanAttributes' })
    this.pushTraceIdFilter(whereClause, params, query.traceId)
    this.pushAttributeFilter(whereClause, params, 'SpanAttributes', 'boxlite.user_id', 'userId', query.userId)
    this.pushAttributeFilter(whereClause, params, 'SpanAttributes', 'boxlite.request_id', 'requestId', query.requestId)
    this.pushAttributeFilter(
      whereClause,
      params,
      'SpanAttributes',
      'boxlite.operation_id',
      'operationId',
      query.operationId,
    )
    this.pushAttributeFilter(
      whereClause,
      params,
      'SpanAttributes',
      'boxlite.execution_id',
      'executionId',
      query.executionId,
    )
    this.pushAttributeFilter(whereClause, params, 'SpanAttributes', 'boxlite.job_id', 'jobId', query.jobId)
    const whereSql = whereClause.join('\n        AND ')

    const countResult = await this.clickhouseService.query<ClickHouseCountRow>(
      `
      SELECT count(DISTINCT TraceId) as count
      FROM otel_traces
      WHERE ${whereSql}
    `,
      params,
    )
    const total = countResult[0]?.count || 0

    const rows = await this.clickhouseService.query<ClickHouseTraceAggregateRow>(
      `
      SELECT
        TraceId,
        min(Timestamp) as startTime,
        max(Timestamp) as endTime,
        count() as spanCount,
        argMinIf(SpanName, Timestamp, ParentSpanId = '') as rootSpanName,
        max(Duration) as totalDuration,
        any(StatusCode) as statusCode
      FROM otel_traces
      WHERE ${whereSql}
      GROUP BY TraceId
      ORDER BY startTime DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
      params,
    )

    return {
      items: rows.map((row) => ({
        traceId: row.TraceId,
        rootSpanName: row.rootSpanName,
        startTime: row.startTime,
        endTime: row.endTime,
        durationMs: row.totalDuration / 1_000_000,
        spanCount: row.spanCount,
        statusCode: row.statusCode || undefined,
      })) as TraceSummaryDto[],
      total,
      page: query.page ?? 1,
      totalPages: Math.ceil(total / (query.limit ?? 100)),
    }
  }

  async getTraceSpans(traceId: string, query: AdminObservabilityQueryParamsDto): Promise<TraceSpanDto[]> {
    this.assertConfigured()
    const params = this.buildBaseParams(query)
    params.traceId = traceId
    const whereClause = this.buildWhereClause('Timestamp', query, params, { eventAttributesColumn: 'SpanAttributes' })
    whereClause.push('TraceId = {traceId:String}')

    const rows = await this.clickhouseService.query<ClickHouseSpanRow>(
      `
      SELECT TraceId, SpanId, ParentSpanId, SpanName, Timestamp, Duration, ServiceName,
             ResourceAttributes, SpanAttributes, StatusCode, StatusMessage
      FROM otel_traces
      WHERE ${whereClause.join('\n        AND ')}
      ORDER BY Timestamp ASC
    `,
      params,
    )

    return rows.map((row) => this.toTraceSpan(row))
  }

  async getMetrics(query: AdminObservabilityMetricsQueryParamsDto): Promise<MetricsResponseDto> {
    this.assertConfigured()
    const params = this.buildBaseParams(query)
    const whereClause = this.buildWhereClause('TimeUnix', query, params)
    if (query.metricNames && query.metricNames.length > 0) {
      whereClause.push('MetricName IN ({metricNames:Array(String)})')
      params.metricNames = query.metricNames
    }

    const rows = await this.clickhouseService.query<ClickHouseMetricRow>(
      `
	      SELECT
	        toStartOfInterval(TimeUnix, INTERVAL 1 MINUTE) as timestamp,
	        MetricName,
	        ${LAYER_EXPRESSION_SQL} as layer,
	        avg(Value) as value
	      FROM (${SCALAR_METRICS_SOURCE_SQL})
      WHERE ${whereClause.join('\n        AND ')}
      GROUP BY timestamp, MetricName, layer
      ORDER BY timestamp ASC
    `,
      params,
    )

    const seriesMap = new Map<
      string,
      { metricName: string; layer?: ObservabilityLayer; dataPoints: MetricDataPointDto[] }
    >()
    for (const row of rows) {
      const layer = OBSERVABILITY_LAYERS.includes(row.layer as ObservabilityLayer)
        ? (row.layer as ObservabilityLayer)
        : undefined
      const seriesKey = `${row.MetricName}:${layer ?? 'unknown'}`
      let series = seriesMap.get(seriesKey)
      if (!series) {
        series = { metricName: row.MetricName, layer, dataPoints: [] }
        seriesMap.set(seriesKey, series)
      }
      series.dataPoints.push({ timestamp: row.timestamp, value: row.value })
    }

    const series: MetricSeriesDto[] = Array.from(seriesMap.values())

    return { series }
  }

  async investigate(
    query: AdminObservabilityInvestigateQueryParamsDto,
  ): Promise<AdminObservabilityInvestigateResponseDto> {
    const correlation = this.createEmptyCorrelation()
    this.collectQueryCorrelation(correlation, query)

    const sources: AdminObservabilitySourceStatusDto[] = []
    let traceSpans: TraceSpanDto[] = []
    let logs: LogEntryDto[] = []
    let metrics: MetricsResponseDto = { series: [] }
    let xlogs: AdminObservabilityXLogDto[] = []
    let s3Objects: AdminObservabilityS3ObjectDto[] = []
    let clickhouseTelemetryCount: number | undefined

    if (!this.clickhouseService.isConfigured()) {
      sources.push({
        source: 'clickhouse',
        state: 'not_configured',
        message: 'ClickHouse/ClickStack is not configured',
        count: 0,
      })
    } else {
      try {
        const traceRows = await this.getInvestigationTraceRows(query)
        traceSpans = traceRows.map((row) => this.toTraceSpan(row))
        for (const row of traceRows) {
          this.collectTraceRowCorrelation(correlation, row)
        }

        const relatedQuery = this.buildRelatedTelemetryQuery(query, correlation)
        const [logPage, metricResponse] = await Promise.all([this.getLogs(relatedQuery), this.getMetrics(relatedQuery)])
        logs = logPage.items
        metrics = metricResponse
        for (const log of logs) {
          this.collectLogCorrelation(correlation, log)
        }

        const clickhouseCount = traceSpans.length + logs.length + metrics.series.length
        clickhouseTelemetryCount = clickhouseCount
        sources.push({
          source: 'clickhouse',
          state: clickhouseCount > 0 ? 'available' : 'missing',
          message:
            clickhouseCount > 0
              ? undefined
              : 'ClickHouse is configured, but no matching OTel logs, traces, or metrics were found for this context',
          count: clickhouseCount,
        })
      } catch (error) {
        sources.push({
          source: 'clickhouse',
          state: 'error',
          message: error instanceof Error ? error.message : 'ClickHouse investigation query failed',
          count: 0,
        })
      }
    }

    const { logs: cloudWatchLogs, cloudWatchStatus } = await this.getRelatedCloudWatchLogs(query, correlation)
    logs = [...logs, ...cloudWatchLogs]
    for (const log of cloudWatchLogs) {
      this.collectLogCorrelation(correlation, log)
    }
    sources.push(cloudWatchStatus)
    xlogs = this.buildXLogs(logs)

    const { boxes, runners, machines, postgresStatus } = await this.getRelatedPlatformState(correlation)
    sources.push(postgresStatus)

    const { auditLogs, auditStatus } = await this.getRelatedAuditLogs(query, correlation)
    sources.push(auditStatus)

    const s3Result = await this.getRelatedS3Objects(correlation)
    s3Objects = s3Result.objects
    sources.push(s3Result.s3Status)

    sources.push(this.buildXLogStatus(query, correlation, xlogs))
    const resource = this.buildResourceSummary(query, correlation, boxes, runners, machines)
    const timeline = this.buildTimeline(traceSpans, logs, auditLogs, xlogs)
    const operations = this.buildOperations(boxes, runners)
    const commands = this.buildCommands(query, correlation)
    const externalLinks = this.buildExternalLinks(query, correlation)
    sources.push(this.buildClickStackStatus(externalLinks, clickhouseTelemetryCount))

    return {
      resource,
      correlation,
      sources,
      traceSpans,
      logs,
      metrics,
      boxes,
      runners,
      machines,
      auditLogs,
      xlogs,
      s3Objects,
      timeline,
      operations,
      commands,
      externalLinks,
    }
  }

  private assertConfigured() {
    if (!this.clickhouseService.isConfigured()) {
      throw new ServiceUnavailableException('ClickHouse/ClickStack is not configured')
    }
  }

  private buildResourceSummary(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
    boxes: AdminBoxItemDto[],
    runners: AdminRunnerItemDto[],
    machines: AdminMachineItemDto[],
  ): AdminObservabilityResourceSummaryDto {
    const timeRange = this.buildTimeRange(query)
    const base = {
      identifiers: this.buildIdentifierMap(correlation),
      timeRange: {
        from: timeRange.from.toISOString(),
        to: timeRange.to.toISOString(),
      },
    }

    const hasObjectTarget = Boolean(query.boxId || query.runnerId || query.machineId)
    const hasEventTarget = Boolean(
      query.traceId || query.requestId || query.operationId || query.executionId || query.jobId,
    )
    if (!hasObjectTarget && !hasEventTarget && (query.userId || correlation.userIds[0])) {
      const userId = query.userId ?? correlation.userIds[0]
      return {
        ...base,
        type: 'user',
        title: `User ${userId}`,
        subtitle: correlation.orgIds[0] ? `Organization ${correlation.orgIds[0]}` : undefined,
      }
    }

    if (!hasObjectTarget && !hasEventTarget && (query.orgId || correlation.orgIds[0])) {
      const orgId = query.orgId ?? correlation.orgIds[0]
      return {
        ...base,
        type: 'org',
        title: `Organization ${orgId}`,
      }
    }

    const box = boxes[0]
    if (box) {
      return {
        ...base,
        type: 'box',
        title: box.boxId ? `Box ${box.boxId}` : `Box ${box.id}`,
        subtitle: box.id,
        state: box.state,
        owner: box.owner?.email || box.owner?.name,
      }
    }

    const runner = runners[0]
    if (runner) {
      return {
        ...base,
        type: 'runner',
        title: `Runner ${runner.id}`,
        subtitle: runner.region,
        state: runner.draining ? 'draining' : runner.state,
      }
    }

    const machine = machines[0]
    if (machine) {
      return {
        ...base,
        type: 'machine',
        title: `Machine ${machine.host}`,
        subtitle: machine.region,
        state: machine.cpuWaterline >= 90 || machine.memWaterline >= 90 ? 'pressure' : 'online',
      }
    }

    if (correlation.traceIds[0]) {
      return {
        ...base,
        type: 'trace',
        title: `Trace ${correlation.traceIds[0]}`,
      }
    }

    if (correlation.requestIds[0]) {
      return {
        ...base,
        type: 'request',
        title: `Request ${correlation.requestIds[0]}`,
      }
    }

    if (correlation.operationIds[0]) {
      return {
        ...base,
        type: 'operation',
        title: `Operation ${correlation.operationIds[0]}`,
      }
    }

    if (correlation.executionIds[0]) {
      return {
        ...base,
        type: 'execution',
        title: `Execution ${correlation.executionIds[0]}`,
      }
    }

    if (correlation.jobIds[0]) {
      return {
        ...base,
        type: 'job',
        title: `Job ${correlation.jobIds[0]}`,
      }
    }

    return {
      ...base,
      type: 'unknown',
      title: 'Platform investigation',
      subtitle: 'No specific resource has been resolved yet',
    }
  }

  private buildIdentifierMap(correlation: AdminObservabilityCorrelationDto): Record<string, string> {
    const identifiers: Record<string, string> = {}
    const entries: Array<[string, string | undefined]> = [
      ['traceId', correlation.traceIds[0]],
      ['orgId', correlation.orgIds[0]],
      ['userId', correlation.userIds[0]],
      ['boxId', correlation.boxIds[0]],
      ['runnerId', correlation.runnerIds[0]],
      ['machineId', correlation.machineIds[0]],
      ['requestId', correlation.requestIds[0]],
      ['operationId', correlation.operationIds[0]],
      ['executionId', correlation.executionIds[0]],
      ['jobId', correlation.jobIds[0]],
    ]
    for (const [key, value] of entries) {
      if (value) identifiers[key] = value
    }
    return identifiers
  }

  private buildTimeline(
    traceSpans: TraceSpanDto[],
    logs: LogEntryDto[],
    auditLogs: AdminObservabilityAuditLogDto[],
    xlogs: AdminObservabilityXLogDto[],
  ): AdminObservabilityTimelineEventDto[] {
    const events: AdminObservabilityTimelineEventDto[] = [
      ...traceSpans.map((span) => ({
        timestamp: span.timestamp,
        source: 'trace',
        title: span.spanName,
        detail: span.statusMessage,
        severity: span.statusCode,
        identifiers: {
          traceId: span.traceId,
          spanId: span.spanId,
        },
      })),
      ...logs.map((log) => ({
        timestamp: log.timestamp,
        source: 'log',
        title: log.serviceName || 'log',
        detail: log.body,
        severity: log.severityText,
        identifiers: {
          ...(log.traceId ? { traceId: log.traceId } : {}),
          ...(log.spanId ? { spanId: log.spanId } : {}),
        },
      })),
      ...auditLogs.map((log) => ({
        timestamp: log.createdAt instanceof Date ? log.createdAt.toISOString() : String(log.createdAt),
        source: 'audit',
        title: log.action,
        detail: log.errorMessage || log.actorEmail,
        severity: log.statusCode && log.statusCode >= 400 ? 'error' : 'info',
        identifiers: {
          ...(log.organizationId ? { orgId: log.organizationId } : {}),
          ...(log.targetId ? { targetId: log.targetId } : {}),
          ...(log.source ? { requestSource: log.source } : {}),
        },
      })),
      ...xlogs.map((log) => ({
        timestamp: log.timestamp,
        source: 'xlog',
        title: log.stream || log.serviceName,
        detail: log.body,
        severity: log.severityText,
        identifiers: {
          ...(log.executionId ? { executionId: log.executionId } : {}),
          ...(log.jobId ? { jobId: log.jobId } : {}),
          ...(log.traceId ? { traceId: log.traceId } : {}),
        },
      })),
    ]

    return events
      .filter((event) => Number.isFinite(new Date(event.timestamp).getTime()))
      .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
      .slice(0, 100)
  }

  private buildOperations(boxes: AdminBoxItemDto[], runners: AdminRunnerItemDto[]): AdminObservabilityOperationDto[] {
    const operations: AdminObservabilityOperationDto[] = []
    for (const box of boxes.slice(0, 5)) {
      const state = String(box.state).toLowerCase()
      const canRecover = state.includes('error') || state.includes('failed')
      operations.push({
        id: `recover:${box.id}`,
        label: 'Recover box',
        state: canRecover ? 'enabled' : 'disabled',
        method: 'POST',
        path: `/admin/box/${box.id}/recover`,
        targetId: box.id,
        reason: canRecover ? 'Box is in a recoverable failure state' : 'Recover is only enabled for failed boxes',
      })
      operations.push({
        id: `resize:${box.id}`,
        label: 'Resize box',
        state: 'request_only',
        method: 'POST',
        path: `/admin/box/${box.id}/resize-request`,
        targetId: box.id,
        reason: 'Resize requires an explicit request flow; direct resize is disabled in first phase',
      })
    }

    for (const runner of runners.slice(0, 5)) {
      operations.push({
        id: `cordon:${runner.id}`,
        label: runner.unschedulable ? 'Uncordon runner' : 'Cordon runner',
        state: 'enabled',
        method: 'PATCH',
        path: `/admin/runners/${runner.id}/scheduling`,
        targetId: runner.id,
        reason: runner.unschedulable
          ? 'Runner is already cordoned and can be returned to scheduling'
          : 'Prevent new boxes from scheduling on this runner',
      })
      operations.push({
        id: `drain:${runner.id}`,
        label: 'Drain runner',
        state: runner.draining ? 'disabled' : 'enabled',
        method: 'PATCH',
        path: `/admin/runners/${runner.id}/draining`,
        targetId: runner.id,
        reason: runner.draining ? 'Runner is already draining' : 'Move runner into draining mode',
      })
      operations.push({
        id: `scale:${runner.id}`,
        label: 'Scale fleet',
        state: 'request_only',
        method: 'POST',
        path: `/admin/runners/${runner.id}/scale-request`,
        targetId: runner.id,
        reason: 'Fleet scaling is intentionally request-only in the first Admin Diagnose phase',
      })
    }

    if (operations.length === 0) {
      operations.push({
        id: 'quota:request',
        label: 'Request quota change',
        state: 'request_only',
        method: 'POST',
        path: '/admin/quota/request',
        reason: 'No concrete box or runner was resolved; quota actions need a scoped resource',
      })
    }

    return operations
  }

  private buildCommands(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): AdminObservabilityCommandsDto {
    const queryString = this.buildInvestigationQueryString(query, correlation)
    return {
      api: `GET /admin/observability/investigate${queryString ? `?${queryString}` : ''}`,
      aiAgentPrompt:
        `Use BoxLite Admin API only. Query GET /admin/observability/investigate${queryString ? `?${queryString}` : ''} ` +
        'with header X-BoxLite-Source=agent, then summarize resource, sources, missing reasons, timeline, xLog, audit, and next operations.',
    }
  }

  private buildExternalLinks(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): AdminObservabilityExternalLinksDto {
    const baseUrl = this.configService.get('observability.clickstackBaseUrl')
    const dashboardUrl = this.configService.get('observability.clickstackDashboardUrl')
    const logSourceId = this.configService.get('observability.clickstackLogSourceId')
    const traceSourceId = this.configService.get('observability.clickstackTraceSourceId')
    const metricSourceId = this.configService.get('observability.clickstackMetricSourceId')
    const timeRange = this.buildTimeRange(query)
    const queryContext = this.buildClickStackQueryContext(query, correlation)
    const clickstackLogQuery = this.buildClickStackQuery(correlation, 'LogAttributes')
    const clickstackTraceQuery = this.buildClickStackQuery(correlation, 'SpanAttributes')
    const missingSources = [
      ...(!logSourceId ? ['logs'] : []),
      ...(!traceSourceId ? ['traces'] : []),
      ...(!metricSourceId ? ['metrics'] : []),
    ]
    const sourceSetup = this.buildClickStackSourceSetup(missingSources)
    if (!baseUrl) {
      return {
        clickstack: {
          configured: false,
          message: 'ADMIN_OBSERVABILITY_CLICKSTACK_URL is not configured',
          sourceSetup,
          query: clickstackTraceQuery,
          queryContext,
        },
      }
    }

    return {
      clickstack: {
        configured: true,
        missingSources,
        sourceSetup,
        message:
          missingSources.length > 0
            ? `ClickStack is reachable, but ${missingSources.join(', ')} source id${
                missingSources.length === 1 ? '' : 's'
              } need to be configured for one-click queries`
            : undefined,
        dashboardUrl,
        logsUrl: this.buildClickStackSearchUrl(baseUrl, {
          sourceId: logSourceId,
          timeRange,
          where: clickstackLogQuery,
        }),
        tracesUrl: this.buildClickStackSearchUrl(baseUrl, {
          sourceId: traceSourceId,
          timeRange,
          where: clickstackTraceQuery,
          traceId: correlation.traceIds[0],
        }),
        metricsUrl: this.buildClickStackChartUrl(baseUrl, {
          sourceId: metricSourceId,
          timeRange,
        }),
        query: clickstackTraceQuery,
        queryContext,
      },
    }
  }

  private buildClickStackSourceSetup(
    missingSources: string[],
  ): AdminObservabilityClickStackSourceSetupDto[] | undefined {
    if (missingSources.length === 0) {
      return undefined
    }

    const allSources: Record<string, AdminObservabilityClickStackSourceSetupDto> = {
      logs: {
        kind: 'logs',
        envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID',
        name: 'BoxLite Logs',
        dataType: 'Log',
        database: 'otel',
        table: 'otel_logs',
        timestampColumn: 'Timestamp',
        defaultSelect: 'Timestamp, ServiceName, SeverityText, Body',
        fields: {
          serviceName: 'ServiceName',
          severityText: 'SeverityText',
          body: 'Body',
          eventAttributes: 'LogAttributes',
          resourceAttributes: 'ResourceAttributes',
          traceId: 'TraceId',
          spanId: 'SpanId',
          implicitColumn: 'Body',
          displayedTimestamp: 'Timestamp',
        },
      },
      traces: {
        kind: 'traces',
        envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID',
        name: 'BoxLite Traces',
        dataType: 'Trace',
        database: 'otel',
        table: 'otel_traces',
        timestampColumn: 'Timestamp',
        defaultSelect: 'Timestamp, ServiceName, StatusCode, round(Duration / 1e6), SpanName',
        fields: {
          serviceName: 'ServiceName',
          eventAttributes: 'SpanAttributes',
          resourceAttributes: 'ResourceAttributes',
          traceId: 'TraceId',
          spanId: 'SpanId',
          duration: 'Duration',
          durationPrecision: '9',
          parentSpanId: 'ParentSpanId',
          spanName: 'SpanName',
          spanKind: 'SpanKind',
          statusCode: 'StatusCode',
          statusMessage: 'StatusMessage',
          spanEvents: 'Events',
          implicitColumn: 'SpanName',
          displayedTimestamp: 'Timestamp',
        },
      },
      metrics: {
        kind: 'metrics',
        envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID',
        name: 'BoxLite Metrics',
        dataType: 'OTEL Metrics',
        database: 'otel',
        timestampColumn: 'TimeUnix',
        fields: {
          serviceName: 'ServiceName',
          resourceAttributes: 'ResourceAttributes',
        },
        metricTables: {
          gauge: 'otel_metrics_gauge',
          histogram: 'otel_metrics_histogram',
          sum: 'otel_metrics_sum',
          summary: 'otel_metrics_summary',
          'exponential histogram': 'otel_metrics_exponential_histogram',
        },
      },
    }

    return missingSources.map((source) => allSources[source]).filter(Boolean)
  }

  private buildClickStackStatus(
    externalLinks: AdminObservabilityExternalLinksDto,
    clickhouseTelemetryCount?: number,
  ): AdminObservabilitySourceStatusDto {
    if (externalLinks.clickstack.configured) {
      const missingSources = externalLinks.clickstack.missingSources ?? []
      if (missingSources.length > 0) {
        return {
          source: 'clickstack',
          state: 'missing',
          message: externalLinks.clickstack.message,
          count: 3 - missingSources.length,
        }
      }
      if (clickhouseTelemetryCount === 0) {
        return {
          source: 'clickstack',
          state: 'missing',
          message:
            'ClickStack source ids are configured, but ClickHouse has no matching OTel rows for this investigation; the third-party page will be empty until collector ingestion writes data',
          count: 0,
        }
      }

      return {
        source: 'clickstack',
        state: 'available',
        message: 'ClickStack deep links are configured for human exploration',
        count: 3,
      }
    }

    return {
      source: 'clickstack',
      state: 'not_configured',
      message: externalLinks.clickstack.message,
      count: 0,
    }
  }

  private buildClickStackSearchUrl(
    baseUrl: string,
    options: {
      sourceId?: string
      timeRange: { from: Date; to: Date }
      where: string
      traceId?: string
    },
  ): string {
    try {
      const url = new URL(baseUrl)
      url.pathname = '/search'
      if (options.sourceId) {
        url.searchParams.set('source', options.sourceId)
      }
      url.searchParams.set('from', options.timeRange.from.getTime().toString())
      url.searchParams.set('to', options.timeRange.to.getTime().toString())
      url.searchParams.set('isLive', 'false')
      url.searchParams.set('where', options.where)
      url.searchParams.set('whereLanguage', 'sql')
      if (options.traceId) {
        url.searchParams.set('traceId', options.traceId)
      }
      return url.toString()
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?'
      const params = new URLSearchParams({
        from: options.timeRange.from.getTime().toString(),
        to: options.timeRange.to.getTime().toString(),
        isLive: 'false',
        where: options.where,
        whereLanguage: 'sql',
      })
      if (options.sourceId) {
        params.set('source', options.sourceId)
      }
      if (options.traceId) {
        params.set('traceId', options.traceId)
      }
      return `${baseUrl}${separator}${params.toString()}`
    }
  }

  private buildClickStackChartUrl(
    baseUrl: string,
    options: {
      sourceId?: string
      timeRange: { from: Date; to: Date }
    },
  ): string {
    const config = options.sourceId
      ? JSON.stringify({
          source: options.sourceId,
          select: [
            {
              aggFn: 'count',
              aggCondition: '',
              aggConditionLanguage: 'lucene',
              valueExpression: '',
            },
          ],
          where: '',
          whereLanguage: 'lucene',
          displayType: 'line',
          granularity: 'auto',
          alignDateRangeToGranularity: true,
        })
      : undefined
    try {
      const url = new URL(baseUrl)
      url.pathname = '/chart'
      url.searchParams.set('from', options.timeRange.from.getTime().toString())
      url.searchParams.set('to', options.timeRange.to.getTime().toString())
      url.searchParams.set('isLive', 'false')
      if (config) {
        url.searchParams.set('config', config)
      }
      return url.toString()
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?'
      const params = new URLSearchParams({
        from: options.timeRange.from.getTime().toString(),
        to: options.timeRange.to.getTime().toString(),
        isLive: 'false',
      })
      if (config) {
        params.set('config', config)
      }
      return `${baseUrl}${separator}${params.toString()}`
    }
  }

  private buildClickStackQueryContext(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): Record<string, unknown> {
    const timeRange = this.buildTimeRange(query)
    return {
      from: timeRange.from.toISOString(),
      to: timeRange.to.toISOString(),
      ...this.buildIdentifierMap(correlation),
    }
  }

  private buildClickStackQuery(
    correlation: AdminObservabilityCorrelationDto,
    eventAttributesColumn?: 'LogAttributes' | 'SpanAttributes',
  ): string {
    const clauses = [
      this.queryClause('TraceId', correlation.traceIds[0]),
      ...this.attributeQueryClauses('boxlite.org_id', correlation.orgIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.user_id', correlation.userIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.box_id', correlation.boxIds[0], eventAttributesColumn),
      this.queryClause('ServiceName', this.boxServiceName(correlation.boxIds[0])),
      ...this.attributeQueryClauses('boxlite.runner_id', correlation.runnerIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.machine_id', correlation.machineIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.execution_id', correlation.executionIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.job_id', correlation.jobIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.request_id', correlation.requestIds[0], eventAttributesColumn),
      ...this.attributeQueryClauses('boxlite.operation_id', correlation.operationIds[0], eventAttributesColumn),
    ].filter((clause): clause is string => Boolean(clause))
    return clauses.length > 0 ? clauses.join(' OR ') : "ServiceName != ''"
  }

  private attributeQueryClauses(
    attributeName: string,
    value?: string,
    eventAttributesColumn?: 'LogAttributes' | 'SpanAttributes',
  ): string[] {
    if (!value) {
      return []
    }
    return [
      this.queryClause(`ResourceAttributes['${attributeName}']`, value),
      eventAttributesColumn ? this.queryClause(`${eventAttributesColumn}['${attributeName}']`, value) : undefined,
    ].filter((clause): clause is string => Boolean(clause))
  }

  private queryClause(field: string, value?: string): string | undefined {
    if (!value) {
      return undefined
    }
    return `${field} = '${value.replace(/'/g, "\\'")}'`
  }

  private buildInvestigationQueryString(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): string {
    const params = new URLSearchParams()
    const timeRange = this.buildTimeRange(query)
    params.set('from', timeRange.from.toISOString())
    params.set('to', timeRange.to.toISOString())
    params.set('limit', String(query.limit ?? 100))
    const identifiers = this.buildIdentifierMap(correlation)
    for (const [key, value] of Object.entries(identifiers)) {
      params.set(key, value)
    }
    return params.toString()
  }

  private buildMissingLayers(): AdminObservabilityLayerStatusDto[] {
    return OBSERVABILITY_LAYERS.map((layer) => ({
      layer,
      state: 'missing',
      signals: { logs: 'missing', traces: 'missing', metrics: 'missing' },
    }))
  }

  private buildConfiguredLayers(rows: StatusRow[]): AdminObservabilityLayerStatusDto[] {
    const now = Date.now()
    return OBSERVABILITY_LAYERS.map((layer) => {
      const signals: AdminObservabilityLayerSignalsDto = {
        logs: 'configured',
        traces: 'configured',
        metrics: 'configured',
      }
      let lastSeenMs = 0

      for (const signal of SIGNALS) {
        const row = rows.find((candidate) => candidate.layer === layer && candidate.signal === signal)
        if (row?.lastSeenMs === undefined || row.lastSeenMs === null) {
          continue
        }
        const seenAt = Number(row.lastSeenMs)
        if (!Number.isFinite(seenAt)) {
          continue
        }
        lastSeenMs = Math.max(lastSeenMs, seenAt)
        signals[signal] = now - seenAt <= STALE_AFTER_MS ? 'receiving' : 'stale'
      }

      const state = this.mergeSignalState(signals)
      return {
        layer,
        state,
        signals,
        ...(lastSeenMs > 0 ? { lastSeen: new Date(lastSeenMs).toISOString() } : {}),
      }
    })
  }

  private mergeSignalState(signals: AdminObservabilityLayerSignalsDto): ObservabilityState {
    if (SIGNALS.some((signal) => signals[signal] === 'receiving')) {
      return 'receiving'
    }
    if (SIGNALS.some((signal) => signals[signal] === 'stale')) {
      return 'stale'
    }
    return 'configured'
  }

  private async getInvestigationTraceRows(
    query: AdminObservabilityInvestigateQueryParamsDto,
  ): Promise<ClickHouseSpanRow[]> {
    const traceIds = query.traceId
      ? [query.traceId]
      : (await this.getTraces({ ...query, page: 1, limit: 5 })).items.map((trace) => trace.traceId)
    if (traceIds.length === 0) {
      return []
    }

    const rows: ClickHouseSpanRow[] = []
    for (const traceId of traceIds.slice(0, 5)) {
      const params = this.buildBaseParams(query)
      params.traceId = traceId
      const whereClause = this.buildWhereClause('Timestamp', query, params, { eventAttributesColumn: 'SpanAttributes' })
      whereClause.push('TraceId = {traceId:String}')

      rows.push(
        ...(await this.clickhouseService.query<ClickHouseSpanRow>(
          `
          SELECT TraceId, SpanId, ParentSpanId, SpanName, Timestamp, Duration, ServiceName,
                 ResourceAttributes, SpanAttributes, StatusCode, StatusMessage
          FROM otel_traces
          WHERE ${whereClause.join('\n        AND ')}
          ORDER BY Timestamp ASC
        `,
          params,
        )),
      )
    }

    return rows
  }

  private toTraceSpan(row: ClickHouseSpanRow): TraceSpanDto {
    return {
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId || undefined,
      spanName: row.SpanName,
      serviceName: row.ServiceName || undefined,
      layer: resolveSpanLayer(row.ServiceName, row.ResourceAttributes) || undefined,
      timestamp: row.Timestamp,
      durationNs: row.Duration,
      spanAttributes: row.SpanAttributes || {},
      statusCode: row.StatusCode || undefined,
      statusMessage: row.StatusMessage || undefined,
    }
  }

  private buildRelatedTelemetryQuery(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): AdminObservabilityLogsQueryParamsDto & AdminObservabilityMetricsQueryParamsDto {
    // When the caller targets a specific resource (box/runner/machine), do NOT
    // narrow related logs/metrics by an org/user id harvested from correlated API spans.
    // Self-emitted box/runner telemetry carries ServiceName (box-<id>) + underscore
    // attrs, not the dot-namespaced boxlite.org_id the org filter matches, so an AND-ed
    // org clause silently drops exactly those rows. The resource id is already org-scoped,
    // so omitting the harvested org filter does not broaden results across orgs.
    const resourceTargeted = Boolean(query.boxId || query.runnerId || query.machineId)
    return {
      ...query,
      page: 1,
      limit: Math.min(query.limit ?? 100, 100),
      traceId: query.traceId ?? correlation.traceIds[0],
      orgId: resourceTargeted ? query.orgId : (query.orgId ?? correlation.orgIds[0]),
      userId: resourceTargeted ? query.userId : (query.userId ?? correlation.userIds[0]),
      boxId: query.boxId ?? correlation.boxIds[0],
      runnerId: query.runnerId ?? correlation.runnerIds[0],
      machineId: query.machineId ?? correlation.machineIds[0],
      requestId: query.requestId ?? correlation.requestIds[0],
      operationId: query.operationId ?? correlation.operationIds[0],
      executionId: query.executionId ?? correlation.executionIds[0],
      jobId: query.jobId ?? correlation.jobIds[0],
    }
  }

  private createEmptyCorrelation(): AdminObservabilityCorrelationDto {
    return {
      traceIds: [],
      orgIds: [],
      userIds: [],
      boxIds: [],
      runnerIds: [],
      machineIds: [],
      requestIds: [],
      operationIds: [],
      executionIds: [],
      jobIds: [],
      serviceNames: [],
    }
  }

  private collectQueryCorrelation(
    correlation: AdminObservabilityCorrelationDto,
    query: AdminObservabilityInvestigateQueryParamsDto,
  ) {
    this.addUnique(correlation.traceIds, query.traceId)
    this.addUnique(correlation.orgIds, query.orgId)
    this.addUnique(correlation.userIds, query.userId)
    this.addUnique(correlation.boxIds, query.boxId)
    this.addUnique(correlation.runnerIds, query.runnerId)
    this.addUnique(correlation.machineIds, query.machineId)
    this.addUnique(correlation.requestIds, query.requestId)
    this.addUnique(correlation.operationIds, query.operationId)
    this.addUnique(correlation.executionIds, query.executionId)
    this.addUnique(correlation.jobIds, query.jobId)
    this.addUnique(correlation.serviceNames, query.serviceName)
  }

  private collectTraceRowCorrelation(correlation: AdminObservabilityCorrelationDto, row: ClickHouseSpanRow) {
    this.addUnique(correlation.traceIds, row.TraceId)
    this.collectServiceNameCorrelation(correlation, row.ServiceName)
    this.collectAttributeCorrelation(correlation, row.ResourceAttributes)
    this.collectAttributeCorrelation(correlation, row.SpanAttributes)
  }

  private collectLogCorrelation(correlation: AdminObservabilityCorrelationDto, log: LogEntryDto) {
    this.addUnique(correlation.traceIds, log.traceId)
    this.collectServiceNameCorrelation(correlation, log.serviceName)
    this.collectAttributeCorrelation(correlation, log.resourceAttributes)
    this.collectAttributeCorrelation(correlation, log.logAttributes)
  }

  private buildXLogs(logs: LogEntryDto[]): AdminObservabilityXLogDto[] {
    return logs
      .map((log): AdminObservabilityXLogDto | null => {
        const attributes = {
          ...(log.resourceAttributes ?? {}),
          ...(log.logAttributes ?? {}),
        }
        const executionId = this.readAttribute(attributes, [
          'boxlite.execution_id',
          'execution_id',
          'execution.id',
          'exec_id',
        ])
        const jobId = this.readAttribute(attributes, ['boxlite.job_id', 'job_id', 'job.id'])

        if (!executionId && !jobId) {
          return null
        }

        return {
          source: attributes['boxlite.source'] === 'cloudwatch' ? 'cloudwatch_logs' : 'clickhouse_logs',
          timestamp: log.timestamp,
          serviceName: log.serviceName,
          body: this.resolveXLogBody(log.body, attributes),
          severityText: log.severityText,
          traceId: log.traceId,
          spanId: log.spanId,
          executionId,
          jobId,
          stream: this.readAttribute(attributes, ['boxlite.stream', 'stream', 'log.stream']),
          attributes,
        }
      })
      .filter((entry): entry is AdminObservabilityXLogDto => entry !== null)
  }

  private resolveXLogBody(body: string, attributes: Record<string, unknown>): string {
    return this.readOutputAttribute(attributes, ['boxlite.output', 'xlog.output', 'exec.output']) ?? body
  }

  private readOutputAttribute(attributes: Record<string, unknown>, names: string[]): string | undefined {
    for (const name of names) {
      const value = attributes[name]
      if (typeof value === 'string' && value.length > 0) {
        return value
      }
    }
    return undefined
  }

  private buildXLogStatus(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
    xlogs: AdminObservabilityXLogDto[],
  ): AdminObservabilitySourceStatusDto {
    if (xlogs.length > 0) {
      return { source: 'xlog', state: 'available', count: xlogs.length }
    }

    const hasExecutionContext =
      Boolean(query.executionId || query.jobId) || correlation.executionIds.length > 0 || correlation.jobIds.length > 0

    return {
      source: 'xlog',
      state: 'missing',
      message: hasExecutionContext
        ? 'No ClickHouse logs with execution/job attributes were found for this investigation'
        : 'No execution_id/job_id correlation was discovered; runner attach output is not persisted as historical xLog yet',
      count: 0,
    }
  }

  private collectAttributeCorrelation(
    correlation: AdminObservabilityCorrelationDto,
    attributes?: Record<string, unknown>,
  ) {
    if (!attributes) {
      return
    }
    this.addUnique(correlation.orgIds, attributes['boxlite.org_id'])
    this.addUnique(correlation.userIds, this.readAttribute(attributes, ['boxlite.user_id', 'user_id', 'user.id']))
    this.addUnique(correlation.boxIds, attributes['boxlite.box_id'])
    this.addUnique(correlation.runnerIds, attributes['boxlite.runner_id'])
    this.addUnique(correlation.machineIds, attributes['boxlite.machine_id'])
    this.addUnique(correlation.requestIds, attributes['boxlite.request_id'])
    this.addUnique(correlation.operationIds, attributes['boxlite.operation_id'])
    this.addUnique(correlation.executionIds, attributes['boxlite.execution_id'])
    this.addUnique(correlation.jobIds, attributes['boxlite.job_id'])
  }

  private collectServiceNameCorrelation(correlation: AdminObservabilityCorrelationDto, serviceName?: string) {
    this.addUnique(correlation.serviceNames, serviceName)
    this.addUnique(correlation.boxIds, this.boxIdFromServiceName(serviceName))
  }

  private boxIdFromServiceName(serviceName?: string): string | undefined {
    if (!serviceName?.startsWith('box-')) {
      return undefined
    }
    const boxId = serviceName.slice('box-'.length).trim()
    return boxId || undefined
  }

  private readAttribute(attributes: Record<string, unknown>, names: string[]): string | undefined {
    for (const name of names) {
      const value = attributes[name]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return undefined
  }

  private async getRelatedPlatformState(correlation: AdminObservabilityCorrelationDto): Promise<{
    boxes: AdminBoxItemDto[]
    runners: AdminRunnerItemDto[]
    machines: AdminMachineItemDto[]
    postgresStatus: AdminObservabilitySourceStatusDto
  }> {
    try {
      const [allBoxes, allRunners, allMachines] = await Promise.all([
        this.overviewService.listBoxes(),
        this.overviewService.listRunners(),
        this.overviewService.listMachines(),
      ])

      const boxes = allBoxes.filter((box) => this.matchesBox(box, correlation))
      for (const box of boxes) {
        this.addUnique(correlation.orgIds, box.organizationId)
        this.addUnique(correlation.boxIds, box.id)
        this.addUnique(correlation.boxIds, box.boxId)
        this.addUnique(correlation.runnerIds, box.runnerId)
      }

      const runners = allRunners.filter((runner) => correlation.runnerIds.includes(runner.id))
      for (const runner of runners) {
        this.addUnique(correlation.machineIds, runner.id)
      }

      const machines = allMachines.filter(
        (machine) => correlation.machineIds.includes(machine.host) || correlation.runnerIds.includes(machine.host),
      )
      for (const machine of machines) {
        this.addUnique(correlation.machineIds, machine.host)
      }

      const count = boxes.length + runners.length + machines.length
      return {
        boxes,
        runners,
        machines,
        postgresStatus: {
          source: 'postgres',
          state: count > 0 ? 'available' : 'missing',
          message:
            count > 0
              ? undefined
              : 'Postgres is reachable, but no box, runner, or machine matched the current correlation identifiers',
          count,
        },
      }
    } catch (error) {
      return {
        boxes: [],
        runners: [],
        machines: [],
        postgresStatus: {
          source: 'postgres',
          state: 'error',
          message: error instanceof Error ? error.message : 'Postgres platform state query failed',
          count: 0,
        },
      }
    }
  }

  private async getRelatedAuditLogs(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ auditLogs: AdminObservabilityAuditLogDto[]; auditStatus: AdminObservabilitySourceStatusDto }> {
    try {
      const result = await this.auditService.getAllLogs(1, 50, {
        ...this.buildTimeRange(query),
      })
      const targetIds = this.buildAuditTargetIds(correlation)
      const auditLogs = result.items
        .filter((log) => {
          return (
            (log.organizationId && correlation.orgIds.includes(log.organizationId)) ||
            (log.actorId && correlation.userIds.includes(log.actorId)) ||
            (log.targetId && targetIds.has(log.targetId))
          )
        })
        .map((log) => ({
          id: log.id,
          actorId: log.actorId,
          actorEmail: log.actorEmail,
          organizationId: log.organizationId,
          action: log.action,
          targetType: log.targetType,
          targetId: log.targetId,
          statusCode: log.statusCode,
          errorMessage: log.errorMessage,
          source: log.source,
          metadata: log.metadata,
          createdAt: log.createdAt,
        }))

      return {
        auditLogs,
        auditStatus: {
          source: 'audit',
          state: auditLogs.length > 0 ? 'available' : 'missing',
          message: auditLogs.length > 0 ? undefined : 'No audit logs matched the resolved organization or target IDs',
          count: auditLogs.length,
        },
      }
    } catch (error) {
      return {
        auditLogs: [],
        auditStatus: {
          source: 'audit',
          state: 'error',
          message: error instanceof Error ? error.message : 'AuditLog query failed',
          count: 0,
        },
      }
    }
  }

  private buildAuditTargetIds(correlation: AdminObservabilityCorrelationDto): Set<string> {
    const targetIds = new Set<string>()
    this.addAuditTargetIds(targetIds, correlation.orgIds, 'orgId')
    this.addAuditTargetIds(targetIds, correlation.userIds, 'userId')
    this.addAuditTargetIds(targetIds, correlation.boxIds, 'boxId')
    this.addAuditTargetIds(targetIds, correlation.runnerIds, 'runnerId')
    this.addAuditTargetIds(targetIds, correlation.machineIds, 'machineId')
    return targetIds
  }

  private addAuditTargetIds(targetIds: Set<string>, values: string[], scopedKey: string) {
    for (const value of values) {
      targetIds.add(value)
      targetIds.add(`${scopedKey}:${value}`)
    }
  }

  private async getRelatedCloudWatchLogs(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ logs: LogEntryDto[]; cloudWatchStatus: AdminObservabilitySourceStatusDto }> {
    try {
      const result = await this.cloudWatchLogReader.getRelatedLogs(query, correlation)
      return { logs: result.logs, cloudWatchStatus: result.status }
    } catch (error) {
      return {
        logs: [],
        cloudWatchStatus: {
          source: 'cloudwatch',
          state: 'error',
          message: error instanceof Error ? error.message : 'CloudWatch log lookup failed',
          count: 0,
        },
      }
    }
  }

  private async getRelatedS3Objects(
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ objects: AdminObservabilityS3ObjectDto[]; s3Status: AdminObservabilitySourceStatusDto }> {
    try {
      const result = await this.s3ObjectReader.listRelatedObjects(correlation)
      return { objects: result.objects, s3Status: result.status }
    } catch (error) {
      return {
        objects: [],
        s3Status: {
          source: 's3',
          state: 'error',
          message: error instanceof Error ? error.message : 'S3 object lookup failed',
          count: 0,
        },
      }
    }
  }

  private matchesBox(box: AdminBoxItemDto, correlation: AdminObservabilityCorrelationDto): boolean {
    if (correlation.boxIds.includes(box.id) || (box.boxId && correlation.boxIds.includes(box.boxId))) {
      return true
    }

    if (correlation.boxIds.length > 0) {
      return false
    }

    if (box.runnerId && correlation.runnerIds.includes(box.runnerId)) {
      return true
    }

    return correlation.orgIds.includes(box.organizationId)
  }

  private addUnique(target: string[], value: unknown) {
    if (typeof value !== 'string') {
      return
    }
    const trimmed = value.trim()
    if (trimmed && !target.includes(trimmed)) {
      target.push(trimmed)
    }
  }

  private buildBaseParams(query: AdminObservabilityQueryParamsDto): Record<string, unknown> {
    const page = query.page ?? 1
    const limit = query.limit ?? 100
    return {
      ...this.buildTimeRange(query),
      limit,
      offset: (page - 1) * limit,
    }
  }

  private buildTimeRange(query: AdminObservabilityQueryParamsDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date()
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_OBSERVABILITY_LOOKBACK_MS)
    return { from, to }
  }

  private buildWhereClause(
    timestampColumn: 'Timestamp' | 'TimeUnix',
    query: AdminObservabilityQueryParamsDto,
    params: Record<string, unknown>,
    options: { eventAttributesColumn?: 'LogAttributes' | 'SpanAttributes' } = {},
  ): string[] {
    const whereClause = [`${timestampColumn} >= {from:DateTime64}`, `${timestampColumn} <= {to:DateTime64}`]

    if (query.layer) {
      whereClause.push(`${LAYER_EXPRESSION_SQL} = {layer:String}`)
      params.layer = query.layer
    }
    if (query.serviceName) {
      whereClause.push('ServiceName = {serviceName:String}')
      params.serviceName = query.serviceName
    }
    this.pushResourceAttributeFilter(
      whereClause,
      params,
      'boxlite.org_id',
      'orgId',
      query.orgId,
      options.eventAttributesColumn,
    )
    this.pushResourceAttributeFilter(
      whereClause,
      params,
      'boxlite.user_id',
      'userId',
      query.userId,
      options.eventAttributesColumn,
    )
    this.pushBoxIdFilter(whereClause, params, query.boxId, options.eventAttributesColumn)
    this.pushResourceAttributeFilter(
      whereClause,
      params,
      'boxlite.runner_id',
      'runnerId',
      query.runnerId,
      options.eventAttributesColumn,
    )
    this.pushResourceAttributeFilter(
      whereClause,
      params,
      'boxlite.machine_id',
      'machineId',
      query.machineId,
      options.eventAttributesColumn,
    )

    return whereClause
  }

  private pushResourceAttributeFilter(
    whereClause: string[],
    params: Record<string, unknown>,
    attributeName: string,
    paramName: string,
    value?: string,
    eventAttributesColumn?: 'LogAttributes' | 'SpanAttributes',
  ) {
    if (!value) {
      return
    }
    const clauses = [`ResourceAttributes['${attributeName}'] = {${paramName}:String}`]
    if (eventAttributesColumn) {
      clauses.push(`${eventAttributesColumn}['${attributeName}'] = {${paramName}:String}`)
    }
    whereClause.push(clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`)
    params[paramName] = value
  }

  private pushBoxIdFilter(
    whereClause: string[],
    params: Record<string, unknown>,
    boxId?: string,
    eventAttributesColumn?: 'LogAttributes' | 'SpanAttributes',
  ) {
    if (!boxId) {
      return
    }
    const clauses = [`ResourceAttributes['boxlite.box_id'] = {boxId:String}`]
    if (eventAttributesColumn) {
      clauses.push(`${eventAttributesColumn}['boxlite.box_id'] = {boxId:String}`)
    }
    clauses.push('ServiceName = {boxServiceName:String}')
    whereClause.push(`(${clauses.join(' OR ')})`)
    params.boxId = boxId
    params.boxServiceName = this.boxServiceName(boxId)
  }

  private boxServiceName(boxId?: string): string | undefined {
    return boxId ? `box-${boxId}` : undefined
  }

  private pushTraceIdFilter(whereClause: string[], params: Record<string, unknown>, traceId?: string) {
    if (!traceId) {
      return
    }
    whereClause.push('TraceId = {traceId:String}')
    params.traceId = traceId
  }

  private pushAttributeFilter(
    whereClause: string[],
    params: Record<string, unknown>,
    columnName: 'LogAttributes' | 'SpanAttributes',
    attributeName: string,
    paramName: string,
    value?: string,
  ) {
    if (!value) {
      return
    }
    whereClause.push(
      `(${columnName}['${attributeName}'] = {${paramName}:String} OR ResourceAttributes['${attributeName}'] = {${paramName}:String})`,
    )
    params[paramName] = value
  }
}
