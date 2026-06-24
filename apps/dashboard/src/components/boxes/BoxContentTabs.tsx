/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBoxContentTabs } from '@/lib/dashboard-features'
import { Box } from '@boxlite-ai/api-client'
import { BoxLogsTab } from './BoxLogsTab'
import { BoxMetricsTab } from './BoxMetricsTab'
import { BoxSpendingTab } from './BoxSpendingTab'
import { BoxTracesTab } from './BoxTracesTab'
import { TabValue } from './SearchParams'

interface BoxContentTabsProps {
  box: Box | undefined
  isLoading: boolean
  experimentsEnabled: boolean | undefined
  tab: TabValue
  onTabChange: (tab: TabValue) => void
}

// Bounded surface so observability tabs render with real height inside the
// detail page's centered scrolling column.
const TAB_SHELL =
  'flex flex-col h-[60vh] min-h-[440px] gap-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-card'

export function BoxContentTabs({ box, isLoading, experimentsEnabled, tab, onTabChange }: BoxContentTabsProps) {
  const availableTabs = getBoxContentTabs({ experimentsEnabled })

  if (isLoading) {
    return (
      <div className={TAB_SHELL}>
        <div className="flex items-center gap-0 h-[41px] px-4 shrink-0">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-12 ml-4" />
          <Skeleton className="h-4 w-14 ml-4" />
          <Skeleton className="h-4 w-16 ml-4" />
          <Skeleton className="h-4 w-10 ml-4" />
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      </div>
    )
  }

  if (!box) return null

  if (!experimentsEnabled) {
    return null
  }

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as TabValue)} className={TAB_SHELL}>
      <TabsList
        variant="underline"
        className="h-[41px] shrink-0 overflow-x-auto overflow-y-hidden scrollbar-sm border-b-0"
      >
        {experimentsEnabled &&
          availableTabs.some((value) => ['logs', 'traces', 'metrics', 'spending'].includes(value)) && (
            <>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="traces">Traces</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
              <TabsTrigger value="spending">Spending</TabsTrigger>
            </>
          )}
      </TabsList>

      {experimentsEnabled && (
        <>
          <TabsContent value="logs" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden">
            <BoxLogsTab boxId={box.id} />
          </TabsContent>
          <TabsContent value="traces" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden">
            <BoxTracesTab boxId={box.id} />
          </TabsContent>
          <TabsContent value="metrics" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden">
            <BoxMetricsTab boxId={box.id} />
          </TabsContent>
          <TabsContent
            value="spending"
            className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden"
          >
            <BoxSpendingTab boxId={box.id} />
          </TabsContent>
        </>
      )}
    </Tabs>
  )
}
