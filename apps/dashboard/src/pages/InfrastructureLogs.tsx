/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogTable } from '@/components/telemetry/LogTable'
import { TimeRangeSelector } from '@/components/telemetry/TimeRangeSelector'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChevronLeft, ChevronRight, RefreshCw, Search } from '@/components/ui/icon'
import {
  InfrastructureLogSource,
  PlatformLogSource,
  useInfrastructureLogs,
  usePlatformLogs,
} from '@/hooks/useInfrastructureLogs'
import { subHours } from 'date-fns'
import { ReactNode, useCallback, useMemo, useState } from 'react'
import { LogEntry } from '@boxlite-ai/api-client'
import { SEVERITY_OPTIONS } from '@/components/boxes/SearchParams'

const PAGE_SIZE = 50
const CLOUDWATCH_MAX_RANGE_MS = 24 * 60 * 60 * 1000
const CLICKHOUSE_MAX_RANGE_MS = 72 * 60 * 60 * 1000
const CLOUDWATCH_QUICK_RANGES = { minutes: [15, 30], hours: [1, 3, 6, 12, 24] }
const CLICKHOUSE_QUICK_RANGES = { minutes: [15, 30], hours: [1, 3, 6, 12, 24], days: [3] }

export default function InfrastructureLogs() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Observability logs</h1>
        <p className="text-sm text-muted-foreground">
          Search break-glass infrastructure logs and platform OpenTelemetry logs.
        </p>
      </div>
      <Tabs defaultValue="infrastructure" className="min-h-0 flex-1">
        <TabsList variant="underline">
          <TabsTrigger value="infrastructure">Infrastructure · CloudWatch</TabsTrigger>
          <TabsTrigger value="platform">Platform OTLP · ClickHouse</TabsTrigger>
        </TabsList>
        <TabsContent value="infrastructure" className="min-h-0">
          <CloudWatchLogsPanel />
        </TabsContent>
        <TabsContent value="platform" className="min-h-0">
          <PlatformLogsPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function CloudWatchLogsPanel() {
  const [source, setSource] = useState<InfrastructureLogSource>('runner')
  const [from, setFrom] = useState(() => subHours(new Date(), 1))
  const [to, setTo] = useState(() => new Date())
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const pageIndex = cursors.length - 1
  const query = useMemo(
    () => ({ source, from, to, search: search || undefined, limit: PAGE_SIZE, nextToken: cursors[pageIndex] }),
    [source, from, to, search, cursors, pageIndex],
  )
  const result = useInfrastructureLogs(query)
  const reset = useCallback(() => setCursors([undefined]), [])
  const changeTime = useCallback(
    (nextFrom: Date, nextTo: Date) => {
      setFrom(nextFrom)
      setTo(nextTo)
      reset()
    },
    [reset],
  )
  const submitSearch = () => {
    setSearch(searchInput.trim())
    reset()
  }
  const nextPage = () => {
    if (result.data?.nextToken) setCursors((items) => [...items, result.data?.nextToken])
  }

  return (
    <LogPanel
      controls={
        <>
          <Select
            value={source}
            onValueChange={(value) => {
              setSource(value as InfrastructureLogSource)
              reset()
            }}
          >
            <SelectTrigger className="w-48" size="sm" aria-label="Infrastructure log source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="runner">Runner infrastructure</SelectItem>
              <SelectItem value="collector">OTel Collector</SelectItem>
            </SelectContent>
          </Select>
          <TimeRangeSelector
            onChange={changeTime}
            defaultRange={{ from, to }}
            quickRanges={CLOUDWATCH_QUICK_RANGES}
            maxRangeMs={CLOUDWATCH_MAX_RANGE_MS}
            className="w-auto"
          />
          <SearchInput value={searchInput} onChange={setSearchInput} onSubmit={submitSearch} />
          <Refresh result={result} />
        </>
      }
      result={result}
      footer={
        <PageControls
          label={`Page ${pageIndex + 1} · ${source === 'runner' ? 'Runner infrastructure' : 'OTel Collector'}`}
          previousDisabled={pageIndex === 0}
          nextDisabled={!result.data?.nextToken}
          onPrevious={() => setCursors((items) => items.slice(0, -1))}
          onNext={nextPage}
        />
      }
    />
  )
}

function PlatformLogsPanel() {
  const [source, setSource] = useState<PlatformLogSource>('api')
  const [boxId, setBoxId] = useState('')
  const [from, setFrom] = useState(() => subHours(new Date(), 1))
  const [to, setTo] = useState(() => new Date())
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [traceId, setTraceId] = useState('')
  const [severity, setSeverity] = useState('all')
  const [page, setPage] = useState(1)
  const isTraceIdValid = traceId.length === 0 || /^[0-9a-fA-F]{32}$/.test(traceId)
  const enabled = (source !== 'box' || boxId.trim().length > 0) && isTraceIdValid
  const query = useMemo(
    () => ({
      source,
      boxId: source === 'box' ? boxId.trim() : undefined,
      from,
      to,
      page,
      limit: PAGE_SIZE,
      search: search || undefined,
      severities: severity === 'all' ? undefined : [severity],
      traceId: isTraceIdValid ? traceId.trim() || undefined : undefined,
    }),
    [source, boxId, from, to, page, search, severity, traceId, isTraceIdValid],
  )
  const result = usePlatformLogs(query, enabled)
  const reset = useCallback(() => setPage(1), [])

  return (
    <LogPanel
      controls={
        <>
          <Select
            value={source}
            onValueChange={(value) => {
              setSource(value as PlatformLogSource)
              reset()
            }}
          >
            <SelectTrigger className="w-44" size="sm" aria-label="Platform log source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api">BoxLite API</SelectItem>
              <SelectItem value="worker">BoxLite Worker</SelectItem>
              <SelectItem value="runner">BoxLite Runner</SelectItem>
              <SelectItem value="box">Box OTLP application</SelectItem>
            </SelectContent>
          </Select>
          {source === 'box' && (
            <Input
              aria-label="Box ID"
              placeholder="Exact Box ID"
              value={boxId}
              maxLength={128}
              onChange={(event) => {
                setBoxId(event.target.value)
                reset()
              }}
              className="w-48"
            />
          )}
          <TimeRangeSelector
            onChange={(nextFrom, nextTo) => {
              setFrom(nextFrom)
              setTo(nextTo)
              reset()
            }}
            defaultRange={{ from, to }}
            quickRanges={CLICKHOUSE_QUICK_RANGES}
            maxRangeMs={CLICKHOUSE_MAX_RANGE_MS}
            className="w-auto"
          />
          <SearchInput
            value={searchInput}
            onChange={setSearchInput}
            onSubmit={() => {
              setSearch(searchInput.trim())
              reset()
            }}
          />
          <Select
            value={severity}
            onValueChange={(value) => {
              setSeverity(value)
              reset()
            }}
          >
            <SelectTrigger className="w-32" size="sm" aria-label="Log severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              {SEVERITY_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Trace ID"
            placeholder="Exact Trace ID"
            value={traceId}
            maxLength={32}
            onChange={(event) => {
              setTraceId(event.target.value)
              reset()
            }}
            className="w-56 font-mono"
          />
          <Refresh result={result} disabled={!enabled} />
        </>
      }
      result={result}
      emptyHint={
        source === 'box' && !boxId.trim()
          ? 'Enter an exact Box ID to search Box application logs.'
          : !isTraceIdValid
            ? 'Trace ID must contain exactly 32 hexadecimal characters.'
            : undefined
      }
      footer={
        result.data && result.data.totalPages > 0 ? (
          <PageControls
            label={`Page ${page} of ${result.data.totalPages} · ${result.data.total} logs`}
            previousDisabled={page <= 1}
            nextDisabled={page >= result.data.totalPages}
            onPrevious={() => setPage((value) => Math.max(1, value - 1))}
            onNext={() => setPage((value) => value + 1)}
          />
        ) : undefined
      }
    />
  )
}

interface LogQueryResult {
  data?: { items?: LogEntry[] }
  isLoading: boolean
  isError: boolean
  refetch: () => unknown
}

function LogPanel({
  controls,
  result,
  footer,
  emptyHint,
}: {
  controls: ReactNode
  result: LogQueryResult
  footer?: ReactNode
  emptyHint?: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-start gap-3">{controls}</div>
      {emptyHint ? (
        <div className="flex flex-1 items-center justify-center rounded-md border text-sm text-muted-foreground">
          {emptyHint}
        </div>
      ) : (
        <LogTable
          logs={result.data?.items}
          isLoading={result.isLoading}
          isError={result.isError}
          onRetry={() => result.refetch()}
        />
      )}
      {footer}
    </div>
  )
}

function SearchInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Search logs"
        placeholder="Search logs..."
        value={value}
        maxLength={256}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
        className="w-48"
      />
      <Button variant="outline" size="icon-sm" onClick={onSubmit} aria-label="Submit log search">
        <Search className="size-4" />
      </Button>
    </div>
  )
}

function Refresh({ result, disabled = false }: { result: { refetch: () => unknown }; disabled?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => result.refetch()}
      disabled={disabled}
      className="ml-auto"
      aria-label="Refresh logs"
    >
      <RefreshCw className="size-4" />
    </Button>
  )
}

function PageControls({
  label,
  previousDisabled,
  nextDisabled,
  onPrevious,
  onNext,
}: {
  label: string
  previousDisabled: boolean
  nextDisabled: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={previousDisabled} onClick={onPrevious}>
          <ChevronLeft className="size-4" /> Previous
        </Button>
        <Button variant="outline" size="sm" disabled={nextDisabled} onClick={onNext}>
          Next <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
