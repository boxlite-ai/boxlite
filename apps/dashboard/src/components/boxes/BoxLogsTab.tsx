/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogTable } from '@/components/telemetry/LogTable'
import { TimeRangeSelector } from '@/components/telemetry/TimeRangeSelector'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LogsQueryParams, useBoxLogs } from '@/hooks/useBoxLogs'
import { subHours } from 'date-fns'
import { ChevronLeft, ChevronRight, RefreshCw, Search } from '@/components/ui/icon'
import { useQueryStates } from 'nuqs'
import { useCallback, useMemo, useState } from 'react'
import { logsSearchParams, SEVERITY_OPTIONS, timeRangeSearchParams } from './SearchParams'

export function BoxLogsTab({ boxId }: { boxId: string }) {
  const [params, setParams] = useQueryStates(logsSearchParams)
  const [timeRange, setTimeRange] = useQueryStates(timeRangeSearchParams)
  const [searchInput, setSearchInput] = useState(params.search)
  const limit = 50

  const resolvedFrom = useMemo(() => timeRange.from ?? subHours(new Date(), 1), [timeRange.from])
  const resolvedTo = useMemo(() => timeRange.to ?? new Date(), [timeRange.to])

  const queryParams: LogsQueryParams = useMemo(
    () => ({
      from: resolvedFrom,
      to: resolvedTo,
      page: params.logsPage,
      limit,
      severities: params.severity.length > 0 ? [...params.severity] : undefined,
      search: params.search || undefined,
    }),
    [resolvedFrom, resolvedTo, params.logsPage, params.severity, params.search],
  )

  const { data, isLoading, isError, refetch } = useBoxLogs(boxId, queryParams)

  const handleTimeRangeChange = useCallback(
    (from: Date, to: Date) => {
      setTimeRange({ from, to })
      setParams({ logsPage: 1 })
    },
    [setTimeRange, setParams],
  )

  const handleSearch = useCallback(() => {
    setParams({ search: searchInput, logsPage: 1 })
  }, [searchInput, setParams])

  const handleSeverityChange = useCallback(
    (value: string) => {
      if (value === 'all' || !value) {
        setParams({ severity: [], logsPage: 1 })
      } else {
        setParams({ severity: [value as (typeof SEVERITY_OPTIONS)[number]], logsPage: 1 })
      }
    },
    [setParams],
  )

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <TimeRangeSelector
          onChange={handleTimeRangeChange}
          defaultRange={timeRange.from && timeRange.to ? { from: timeRange.from, to: timeRange.to } : undefined}
          className="w-auto"
        />

        <div className="flex items-center gap-2">
          <Input
            placeholder="Search logs..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="w-48"
          />
          <Button variant="outline" size="icon-sm" onClick={handleSearch}>
            <Search className="size-4" />
          </Button>
        </div>

        <Select value={params.severity.length === 1 ? params.severity[0] : ''} onValueChange={handleSeverityChange}>
          <SelectTrigger className="w-32" size="sm">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {SEVERITY_OPTIONS.map((sev) => (
              <SelectItem key={sev} value={sev}>
                {sev}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="ghost" size="icon-sm" onClick={() => refetch()} className="ml-auto">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <LogTable logs={data?.items} isLoading={isLoading} isError={isError} onRetry={() => refetch()} />

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between shrink-0">
          <span className="text-sm text-muted-foreground">
            Page {params.logsPage} of {data.totalPages} ({data.total} total)
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={params.logsPage <= 1}
              onClick={() => setParams({ logsPage: params.logsPage - 1 })}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={params.logsPage >= data.totalPages}
              onClick={() => setParams({ logsPage: params.logsPage + 1 })}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
