/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogTable } from '@/components/telemetry/LogTable'
import { TimeRangeSelector } from '@/components/telemetry/TimeRangeSelector'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronLeft, ChevronRight, RefreshCw, Search } from '@/components/ui/icon'
import { InfrastructureLogSource, useInfrastructureLogs } from '@/hooks/useInfrastructureLogs'
import { subHours } from 'date-fns'
import { useCallback, useMemo, useState } from 'react'

const PAGE_SIZE = 50

export default function InfrastructureLogs() {
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
  const changeSource = (value: InfrastructureLogSource) => {
    setSource(value)
    reset()
  }
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
    const nextToken = result.data?.nextToken
    if (nextToken) setCursors((items) => [...items, nextToken])
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Infrastructure logs</h1>
        <p className="text-sm text-muted-foreground">
          CloudWatch break-glass logs for Runner hosts and the OTel Collector.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={source} onValueChange={(value) => changeSource(value as InfrastructureLogSource)}>
          <SelectTrigger className="w-44" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="runner">Runner infrastructure</SelectItem>
            <SelectItem value="collector">OTel Collector</SelectItem>
          </SelectContent>
        </Select>
        <TimeRangeSelector onChange={changeTime} defaultRange={{ from, to }} className="w-auto" />
        <div className="flex items-center gap-2">
          <Input
            placeholder="Case-sensitive keyword..."
            value={searchInput}
            maxLength={256}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submitSearch()}
            className="w-56"
          />
          <Button variant="outline" size="icon-sm" onClick={submitSearch}>
            <Search className="size-4" />
          </Button>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => result.refetch()} className="ml-auto">
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <LogTable
        logs={result.data?.items}
        isLoading={result.isLoading}
        isError={result.isError}
        onRetry={() => result.refetch()}
      />
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {pageIndex + 1} · {source === 'runner' ? 'Runner infrastructure' : 'OTel Collector'}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pageIndex === 0}
            onClick={() => setCursors((items) => items.slice(0, -1))}
          >
            <ChevronLeft className="size-4" />
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!result.data?.nextToken} onClick={nextPage}>
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
