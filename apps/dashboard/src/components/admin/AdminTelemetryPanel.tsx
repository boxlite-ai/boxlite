/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { SeverityBadge } from '@/components/telemetry/SeverityBadge'
import { buildTraceWaterfallRows } from '@/components/telemetry/traceWaterfall'
import { Badge, BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateRangePicker, QuickRangesConfig } from '@/components/ui/date-range-picker'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AdminObservabilityBaseParams,
  AdminObservabilityLogEntry,
  AdminObservabilityMetricSeries,
  AdminObservabilitySourceStatus,
  AdminObservabilityStatus,
  AdminObservabilityTraceSummary,
  OBSERVABILITY_LAYERS,
  ObservabilityLayer,
  ObservabilityState,
  useAdminObservabilityInvestigate,
  useAdminObservabilityLogs,
  useAdminObservabilityMetrics,
  useAdminObservabilityStatus,
  useAdminObservabilityTraceSpans,
  useAdminObservabilityTraces,
} from '@/hooks/useAdminObservability'
import { cn } from '@/lib/utils'
import { format, subHours } from 'date-fns'
import { Activity, AlertCircle, BarChart3, FileText, RefreshCw, Search } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { DateRange } from 'react-day-picker'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'

const QUICK_RANGES: QuickRangesConfig = {
  minutes: [15, 30],
  hours: [1, 3, 6, 12, 24],
  days: [3, 7],
}

const PAGE_LIMIT = 30
const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

const LAYER_LABELS: Record<ObservabilityLayer, string> = {
  api: 'API',
  runner: 'Runner',
  ec2_host: 'EC2 Host',
  box: 'Box',
}

const STATE_VARIANTS: Record<ObservabilityState, BadgeProps['variant']> = {
  missing: 'outline',
  configured: 'secondary',
  receiving: 'success',
  stale: 'warning',
  error: 'destructive',
}

const SOURCE_STATE_VARIANTS: Record<AdminObservabilitySourceStatus['state'], BadgeProps['variant']> = {
  available: 'success',
  missing: 'outline',
  stale: 'warning',
  not_configured: 'secondary',
  error: 'destructive',
}

type TelemetryPreset = Partial<Omit<AdminObservabilityBaseParams, 'from' | 'to' | 'page' | 'limit'>>
type CompleteDateRange = { from: Date; to: Date }

interface AdminTelemetryPanelProps {
  title?: string
  description?: string
  preset?: TelemetryPreset
  compact?: boolean
  className?: string
  onDiagnoseTrace?: (traceId: string) => void
  onDiagnoseExecution?: (executionId: string, traceId?: string) => void
  onDiagnoseJob?: (jobId: string, traceId?: string) => void
  onDiagnoseRequest?: (requestId: string, traceId?: string) => void
}

function createDefaultRange(): CompleteDateRange {
  const now = new Date()
  return { from: subHours(now, 1), to: now }
}

function getCompleteRange(range: DateRange): CompleteDateRange {
  const fallback = createDefaultRange()
  return {
    from: range.from ?? fallback.from,
    to: range.to ?? fallback.to,
  }
}

function formatTimestamp(timestamp?: string) {
  if (!timestamp) return '-'
  try {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss.SSS')
  } catch {
    return timestamp
  }
}

function formatDuration(durationMs: number) {
  if (durationMs < 1) return `${(durationMs * 1000).toFixed(2)}us`
  if (durationMs < 1000) return `${durationMs.toFixed(2)}ms`
  return `${(durationMs / 1000).toFixed(2)}s`
}

function truncateMiddle(value: string, head = 8, tail = 8) {
  if (value.length <= head + tail + 3) return value
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

function readAttribute(attributes: Record<string, string> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = attributes?.[key]
    if (value) return value
  }
  return undefined
}

function getLayerFromAttributes(resourceAttributes?: Record<string, string>) {
  const layer = resourceAttributes?.['boxlite.layer']
  return OBSERVABILITY_LAYERS.includes(layer as ObservabilityLayer) ? LAYER_LABELS[layer as ObservabilityLayer] : '-'
}

function getErrorDescription(error: unknown) {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { status?: number; data?: { message?: string } } }).response
    if (response?.status === 403) return 'System Admin access required.'
    if (response?.data?.message) return response.data.message
  }
  if (error instanceof Error) return error.message
  return 'Request failed.'
}

function StateBadge({ state }: { state: ObservabilityState }) {
  return (
    <Badge variant={STATE_VARIANTS[state]} className="capitalize">
      {state}
    </Badge>
  )
}

function QueryError({ error }: { error: unknown }) {
  return (
    <Empty variant="warning" className="min-h-48">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircle className="size-4" />
        </EmptyMedia>
        <EmptyTitle>Unable to load telemetry</EmptyTitle>
        <EmptyDescription>{getErrorDescription(error)}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function EmptyTelemetry({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <Empty variant="neutral" className="min-h-48">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="size-4" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  )
}

function StatusStrip({
  status,
  isLoading,
  compact,
}: {
  status?: AdminObservabilityStatus
  isLoading: boolean
  compact?: boolean
}) {
  const layerStatuses =
    status?.layers ??
    OBSERVABILITY_LAYERS.map((layer) => ({
      layer,
      state: 'missing' as ObservabilityState,
      signals: {
        logs: 'missing' as ObservabilityState,
        traces: 'missing' as ObservabilityState,
        metrics: 'missing' as ObservabilityState,
      },
    }))

  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-5')}>
      <div className="rounded-md border border-border bg-background px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Backend</span>
          {isLoading ? <Spinner className="size-3" /> : <StateBadge state={status?.backend.state ?? 'missing'} />}
        </div>
        {status?.backend.message && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{status.backend.message}</p>
        )}
      </div>

      {layerStatuses.map((layerStatus) => (
        <div key={layerStatus.layer} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{LAYER_LABELS[layerStatus.layer]}</span>
            <StateBadge state={layerStatus.state} />
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">
            logs {layerStatus.signals.logs} · traces {layerStatus.signals.traces} · metrics{' '}
            {layerStatus.signals.metrics}
          </div>
        </div>
      ))}
    </div>
  )
}

function buildChartData(series: AdminObservabilityMetricSeries[]) {
  const timestamps = Array.from(
    new Set(series.flatMap((item) => item.dataPoints.map((point) => point.timestamp))),
  ).sort()
  return timestamps.map((timestamp) => {
    const row: Record<string, string | number | null> = { timestamp }
    for (const [index, item] of series.entries()) {
      row[`series_${index}`] = item.dataPoints.find((point) => point.timestamp === timestamp)?.value ?? null
    }
    return row
  })
}

function MetricsView({
  series,
  isLoading,
  error,
}: {
  series?: AdminObservabilityMetricSeries[]
  isLoading: boolean
  error: unknown
}) {
  const visibleSeries = useMemo(() => (series ?? []).slice(0, 5), [series])
  const chartData = useMemo(() => buildChartData(visibleSeries), [visibleSeries])

  if (error) return <QueryError error={error} />
  if (isLoading) return <Spinner className="m-8 size-5" />
  if (!series?.length) return <EmptyTelemetry icon={BarChart3} title="No metrics found" />

  return (
    <div className="space-y-4">
      <div className="h-64 rounded-md border border-border p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(value) => formatTimestamp(String(value)).slice(11, 19)}
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
            />
            <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
            <RechartsTooltip />
            {visibleSeries.map((item, index) => {
              return (
                <Line
                  key={`${item.metricName}:${item.layer ?? 'unknown'}`}
                  dataKey={`series_${index}`}
                  stroke={CHART_COLORS[index % CHART_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {series.slice(0, 8).map((item) => (
          <div
            key={`${item.metricName}:${item.layer ?? 'unknown'}`}
            className="rounded-md border border-border px-3 py-2"
          >
            <div className="truncate text-xs font-medium">{item.metricName}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {item.layer ? LAYER_LABELS[item.layer] : 'Unknown layer'} · {item.dataPoints.length} points
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LogsView({
  logs,
  total,
  isLoading,
  error,
  onDiagnoseTrace,
  onDiagnoseExecution,
  onDiagnoseJob,
  onDiagnoseRequest,
}: {
  logs?: AdminObservabilityLogEntry[]
  total?: number
  isLoading: boolean
  error: unknown
  onDiagnoseTrace?: (traceId: string) => void
  onDiagnoseExecution?: (executionId: string, traceId?: string) => void
  onDiagnoseJob?: (jobId: string, traceId?: string) => void
  onDiagnoseRequest?: (requestId: string, traceId?: string) => void
}) {
  if (error) return <QueryError error={error} />
  if (isLoading) return <Spinner className="m-8 size-5" />
  if (!logs?.length) return <EmptyTelemetry icon={FileText} title="No logs found" />

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Time</TableHead>
            <TableHead className="w-24">Layer</TableHead>
            <TableHead className="w-24">Severity</TableHead>
            <TableHead className="w-44">Service</TableHead>
            <TableHead>Message</TableHead>
            <TableHead className="w-20 text-right">Trace</TableHead>
            <TableHead className="w-24 text-right">Diagnose</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log, index) => {
            const executionId = readAttribute(log.logAttributes, [
              'boxlite.execution_id',
              'execution_id',
              'execution.id',
            ])
            const jobId = readAttribute(log.logAttributes, ['boxlite.job_id', 'job_id', 'job.id'])
            const requestId = readAttribute(log.logAttributes, ['boxlite.request_id', 'request_id', 'request.id'])
            const diagnose = executionId
              ? () => onDiagnoseExecution?.(executionId, log.traceId)
              : jobId
                ? () => onDiagnoseJob?.(jobId, log.traceId)
                : requestId
                  ? () => onDiagnoseRequest?.(requestId, log.traceId)
                  : log.traceId
                    ? () => onDiagnoseTrace?.(log.traceId as string)
                    : undefined

            return (
              <TableRow key={`${log.timestamp}-${index}`}>
                <TableCell className="font-mono text-xs">{formatTimestamp(log.timestamp)}</TableCell>
                <TableCell className="text-xs">{getLayerFromAttributes(log.resourceAttributes)}</TableCell>
                <TableCell>
                  <SeverityBadge severity={log.severityText} />
                </TableCell>
                <TableCell className="max-w-44 truncate text-xs text-muted-foreground">{log.serviceName}</TableCell>
                <TableCell className="max-w-[28rem] truncate font-mono text-xs">{log.body}</TableCell>
                <TableCell className="text-right">
                  {log.traceId && <CopyButton value={log.traceId} tooltipText="Copy trace ID" size="icon-xs" />}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={!diagnose}
                    onClick={diagnose}
                  >
                    Diagnose
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {total !== undefined && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">{total} total logs</div>
      )}
    </div>
  )
}

function TracesView({
  traces,
  total,
  spans,
  selectedTraceId,
  onSelectTrace,
  onDiagnoseTrace,
  isLoading,
  spansLoading,
  error,
}: {
  traces?: AdminObservabilityTraceSummary[]
  total?: number
  spans?: ReturnType<typeof buildTraceWaterfallRows>
  selectedTraceId: string | null
  onSelectTrace: (traceId: string) => void
  onDiagnoseTrace?: (traceId: string) => void
  isLoading: boolean
  spansLoading: boolean
  error: unknown
}) {
  if (error) return <QueryError error={error} />
  if (isLoading) return <Spinner className="m-8 size-5" />
  if (!traces?.length) return <EmptyTelemetry icon={Activity} title="No traces found" />

  return (
    <div className="grid min-h-[30rem] gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.85fr)]">
      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trace</TableHead>
              <TableHead>Root span</TableHead>
              <TableHead className="w-44">Start</TableHead>
              <TableHead className="w-24">Duration</TableHead>
              <TableHead className="w-16 text-right">Spans</TableHead>
              <TableHead className="w-24 text-right">Diagnose</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {traces.map((trace) => (
              <TableRow
                key={trace.traceId}
                className={cn('cursor-pointer', selectedTraceId === trace.traceId && 'bg-primary/10')}
                onClick={() => onSelectTrace(trace.traceId)}
              >
                <TableCell className="font-mono text-xs">
                  <span>{truncateMiddle(trace.traceId)}</span>
                  <CopyButton value={trace.traceId} tooltipText="Copy trace ID" size="icon-xs" className="ml-1" />
                </TableCell>
                <TableCell className="max-w-72 truncate text-xs">{trace.rootSpanName}</TableCell>
                <TableCell className="font-mono text-xs">{formatTimestamp(trace.startTime)}</TableCell>
                <TableCell className="font-mono text-xs">{formatDuration(trace.durationMs)}</TableCell>
                <TableCell className="text-right tabular-nums">{trace.spanCount}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDiagnoseTrace?.(trace.traceId)
                    }}
                  >
                    Diagnose
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {total !== undefined && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">{total} total traces</div>
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-background">
        <div className="border-b px-3 py-2 text-xs font-medium">Trace spans</div>
        {!selectedTraceId ? (
          <div className="p-4 text-sm text-muted-foreground">Select a trace to inspect its waterfall.</div>
        ) : spansLoading ? (
          <Spinner className="m-6 size-5" />
        ) : !spans?.length ? (
          <div className="p-4 text-sm text-muted-foreground">No spans found for this trace.</div>
        ) : (
          <ScrollArea className="h-[28rem]">
            <div className="space-y-2 p-3">
              {spans.map((span) => (
                <div key={span.spanId} className="space-y-1" style={{ paddingLeft: `${span.depth * 14}px` }}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate font-medium">{span.spanName}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">{formatDuration(span.durationMs)}</span>
                  </div>
                  <div className="h-5 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/70"
                      style={{
                        marginLeft: `${Math.min(span.offsetPercent, 95)}%`,
                        width: `${Math.max(span.widthPercent, 2)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}

function InvestigateView({
  data,
  isLoading,
  error,
}: {
  data: ReturnType<typeof useAdminObservabilityInvestigate>['data']
  isLoading: boolean
  error: unknown
}) {
  if (error) return <QueryError error={error} />
  if (isLoading) return <Spinner className="m-8 size-5" />
  if (!data) return <EmptyTelemetry icon={Search} title="No investigation selected" />

  const correlationEntries = Object.entries(data.correlation).filter(
    ([, values]) => Array.isArray(values) && values.length > 0,
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-3">
        {data.sources.map((source) => (
          <div key={source.source} className="rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium capitalize">{source.source}</span>
              <Badge variant={SOURCE_STATE_VARIANTS[source.state]}>{source.state.replace('_', ' ')}</Badge>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {source.count ?? 0} item(s)
              {source.message ? ` · ${source.message}` : ''}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Trace spans</div>
          <div className="text-2xl font-medium tabular-nums">{data.traceSpans.length}</div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Logs</div>
          <div className="text-2xl font-medium tabular-nums">{data.logs.length}</div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Audit</div>
          <div className="text-2xl font-medium tabular-nums">{data.auditLogs.length}</div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">xLog</div>
          <div className="text-2xl font-medium tabular-nums">{data.xlogs.length}</div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">S3 objects</div>
          <div className="text-2xl font-medium tabular-nums">{data.s3Objects.length}</div>
        </div>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="mb-2 text-xs font-medium">Correlation IDs</div>
        {correlationEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No correlated platform identifiers discovered yet.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {correlationEntries.map(([key, values]) => (
              <div key={key} className="min-w-0 rounded-md bg-muted/35 px-2 py-1.5 text-xs">
                <span className="mr-2 text-muted-foreground">{key}</span>
                <span className="font-mono">
                  {(values as string[]).map((value) => truncateMiddle(value)).join(', ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const AdminTelemetryPanel: React.FC<AdminTelemetryPanelProps> = ({
  title = 'Telemetry',
  description,
  preset = {},
  compact,
  className,
  onDiagnoseTrace,
  onDiagnoseExecution,
  onDiagnoseJob,
  onDiagnoseRequest,
}) => {
  const [activeTab, setActiveTab] = useState('metrics')
  const [dateRange, setDateRange] = useState<DateRange>(() => createDefaultRange())
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const range = getCompleteRange(dateRange)
  const baseParams: AdminObservabilityBaseParams = {
    from: range.from,
    to: range.to,
    page: 1,
    limit: PAGE_LIMIT,
    layer: 'all',
    ...preset,
  }

  const statusQuery = useAdminObservabilityStatus()
  const logsQuery = useAdminObservabilityLogs(
    { ...baseParams, search: search || undefined },
    { enabled: activeTab === 'logs' },
  )
  const tracesQuery = useAdminObservabilityTraces(baseParams, { enabled: activeTab === 'traces' })
  const metricsQuery = useAdminObservabilityMetrics(baseParams, { enabled: activeTab === 'metrics' })
  const traceSpansQuery = useAdminObservabilityTraceSpans(selectedTraceId ?? undefined, baseParams, {
    enabled: activeTab === 'traces' && !!selectedTraceId,
  })
  const investigateQuery = useAdminObservabilityInvestigate(
    { ...baseParams, traceId: selectedTraceId ?? preset.traceId },
    { enabled: activeTab === 'investigate' },
  )

  const waterfallRows = useMemo(() => buildTraceWaterfallRows(traceSpansQuery.data), [traceSpansQuery.data])

  const refreshActive = () => {
    statusQuery.refetch()
    if (activeTab === 'logs') logsQuery.refetch()
    if (activeTab === 'traces') {
      tracesQuery.refetch()
      if (selectedTraceId) traceSpansQuery.refetch()
    }
    if (activeTab === 'metrics') metricsQuery.refetch()
    if (activeTab === 'investigate') investigateQuery.refetch()
  }

  const runLogSearch = () => {
    setSearch(searchInput.trim())
  }

  return (
    <section className={cn('overflow-hidden rounded-md border bg-background/80 shadow-sm', className)}>
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              quickRangesEnabled
              quickRanges={QUICK_RANGES}
              defaultSelectedQuickRange="Last 1 hour"
              className="w-full sm:w-60"
              contentAlign="end"
            />
            <Button variant="outline" size="icon" onClick={refreshActive} aria-label="Refresh telemetry">
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
        <StatusStrip status={statusQuery.data} isLoading={statusQuery.isLoading} compact={compact} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-[34rem] flex-col">
        <TabsList variant="underline" className="gap-8 bg-muted/35 px-4">
          <TabsTrigger value="metrics" className="px-0 py-3 data-[state=active]:text-primary">
            Metrics
          </TabsTrigger>
          <TabsTrigger value="logs" className="px-0 py-3 data-[state=active]:text-primary">
            Logs
          </TabsTrigger>
          <TabsTrigger value="traces" className="px-0 py-3 data-[state=active]:text-primary">
            Traces
          </TabsTrigger>
          <TabsTrigger value="investigate" className="px-0 py-3 data-[state=active]:text-primary">
            Investigate
          </TabsTrigger>
        </TabsList>

        <TabsContent value="metrics" className="m-0 flex-1 p-4">
          <MetricsView
            series={metricsQuery.data?.series}
            isLoading={metricsQuery.isLoading}
            error={metricsQuery.error}
          />
        </TabsContent>

        <TabsContent value="logs" className="m-0 flex-1 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && runLogSearch()}
              placeholder="Search logs"
              className="w-full sm:w-64"
            />
            <Button variant="outline" size="icon" onClick={runLogSearch} aria-label="Search logs">
              <Search className="size-4" />
            </Button>
          </div>
          <LogsView
            logs={logsQuery.data?.items}
            total={logsQuery.data?.total}
            isLoading={logsQuery.isLoading}
            error={logsQuery.error}
            onDiagnoseTrace={onDiagnoseTrace}
            onDiagnoseExecution={onDiagnoseExecution}
            onDiagnoseJob={onDiagnoseJob}
            onDiagnoseRequest={onDiagnoseRequest}
          />
        </TabsContent>

        <TabsContent value="traces" className="m-0 flex-1 p-4">
          <TracesView
            traces={tracesQuery.data?.items}
            total={tracesQuery.data?.total}
            selectedTraceId={selectedTraceId}
            onSelectTrace={setSelectedTraceId}
            spans={waterfallRows}
            isLoading={tracesQuery.isLoading}
            spansLoading={traceSpansQuery.isLoading}
            error={tracesQuery.error}
            onDiagnoseTrace={onDiagnoseTrace}
          />
        </TabsContent>

        <TabsContent value="investigate" className="m-0 flex-1 p-4">
          <InvestigateView
            data={investigateQuery.data}
            isLoading={investigateQuery.isLoading}
            error={investigateQuery.error}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}

export default AdminTelemetryPanel
