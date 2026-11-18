/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Normalized Analytics responses used by the telemetry views.
export interface LogEntry {
  timestamp: string
  body: string
  severityText: string
  severityNumber?: number
  serviceName: string
  resourceAttributes: Record<string, string>
  logAttributes: Record<string, string>
  traceId?: string
  spanId?: string
}

export interface TraceSummary {
  traceId: string
  rootSpanName: string
  startTime: string
  endTime: string
  durationMs: number
  spanCount: number
  statusCode?: string
}

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  spanName: string
  serviceName?: string
  layer?: string
  timestamp: string
  durationNs: number
  spanAttributes: Record<string, string>
  statusCode?: string
  statusMessage?: string
}

export interface MetricDataPoint {
  timestamp: string
  value: number
}

export interface MetricSeries {
  metricName: string
  dataPoints: MetricDataPoint[]
}

export interface MetricsResponse {
  series: MetricSeries[]
}

export interface PaginatedLogs {
  items: LogEntry[]
  total: number
  page: number
  totalPages: number
}

export interface PaginatedTraces {
  items: TraceSummary[]
  total: number
  page: number
  totalPages: number
}
