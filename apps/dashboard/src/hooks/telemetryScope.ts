/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export type TelemetryScope = 'box' | 'admin-platform'

export const adminTelemetryPaths = {
  logs: '/admin/observability/logs',
  traces: '/admin/observability/traces',
  metrics: '/admin/observability/metrics',
  traceSpans: (traceId: string) => `/admin/observability/traces/${encodeURIComponent(traceId)}`,
} as const

interface TelemetrySearchParams {
  from: Date
  to: Date
  page?: number
  limit?: number
  severities?: string[]
  metricNames?: string[]
  search?: string
}

export function buildTelemetrySearchParams(params: TelemetrySearchParams): URLSearchParams {
  const searchParams = new URLSearchParams()
  searchParams.set('from', params.from.toISOString())
  searchParams.set('to', params.to.toISOString())

  if (params.page !== undefined) {
    searchParams.set('page', String(params.page))
  }
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit))
  }
  if (params.search) {
    searchParams.set('search', params.search)
  }
  for (const severity of params.severities ?? []) {
    searchParams.append('severities', severity.toLowerCase())
  }
  for (const metricName of params.metricNames ?? []) {
    searchParams.append('metricNames', metricName)
  }

  return searchParams
}
