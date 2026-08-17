/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxLogsTab, BoxMetricsTab, BoxTracesTab } from '@/components/boxes'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BarChart3 } from '@/components/ui/icon'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const SOURCES = ['api', 'worker', 'runner', 'runtime-wrapper', 'box', 'collector-delivery'] as const
const TABS = ['logs', 'traces', 'metrics'] as const
type ObservabilityTab = (typeof TABS)[number]

export default function Observability() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTab = TABS.includes(searchParams.get('tab') as ObservabilityTab)
    ? (searchParams.get('tab') as ObservabilityTab)
    : 'logs'
  const selectedBoxId = searchParams.get('boxId') ?? ''
  const selectedSource = searchParams.get('source') ?? 'all'
  const [boxInput, setBoxInput] = useState(selectedBoxId)
  const sources = useMemo(() => (selectedSource === 'all' ? undefined : [selectedSource]), [selectedSource])

  useEffect(() => {
    setBoxInput(selectedBoxId)
  }, [selectedBoxId])

  const updateFilter = (name: string, value?: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('logsPage')
    next.delete('tracesPage')
    setSearchParams(next)
  }

  const applyBoxFilter = () => updateFilter('boxId', boxInput.trim() || undefined)

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pb-6 pt-5 sm:px-6 lg:px-10">
      <div className="mb-4 flex flex-none flex-col gap-1">
        <h1 className="font-mono text-xl font-medium">Observability</h1>
        <p className="text-sm text-muted-foreground">
          Search logs, traces, and Box metrics produced while your organization uses BoxLite.
        </p>
      </div>

      <Tabs
        value={selectedTab}
        onValueChange={(value) => updateFilter('tab', value)}
        className="min-h-0 flex-1 gap-0 border border-border bg-background"
      >
        <div className="flex flex-none flex-wrap items-center gap-3 border-b border-border px-4">
          <TabsList variant="underline" className="w-auto border-b-0">
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="traces">Traces</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>

          <div className="ml-auto flex items-center gap-2 py-2">
            <Input
              aria-label="Box ID filter"
              placeholder="Box ID (optional)"
              value={boxInput}
              onChange={(event) => setBoxInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && applyBoxFilter()}
              onBlur={applyBoxFilter}
              className="h-8 w-48 font-mono text-xs"
            />
            {selectedTab !== 'metrics' && (
              <Select
                value={selectedSource}
                onValueChange={(value) => updateFilter('source', value === 'all' ? undefined : value)}
              >
                <SelectTrigger aria-label="Source filter" className="w-44" size="sm">
                  <SelectValue placeholder="All modules" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All modules</SelectItem>
                  {SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <TabsContent value="logs" className="min-h-0 overflow-hidden">
          <BoxLogsTab boxId={selectedBoxId || undefined} sources={sources} />
        </TabsContent>
        <TabsContent value="traces" className="min-h-0 overflow-hidden">
          <BoxTracesTab boxId={selectedBoxId || undefined} sources={sources} />
        </TabsContent>
        <TabsContent value="metrics" className="min-h-0 overflow-hidden">
          {selectedBoxId ? (
            <BoxMetricsTab boxId={selectedBoxId} />
          ) : (
            <Empty className="h-full border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BarChart3 className="size-4" />
                </EmptyMedia>
                <EmptyTitle>Select a Box</EmptyTitle>
                <EmptyDescription>Metrics are scoped to one Box. Enter a Box ID above to load them.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
