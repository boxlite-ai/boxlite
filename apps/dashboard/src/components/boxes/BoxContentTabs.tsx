/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useRegions } from '@/hooks/useRegions'
import { getBoxContentTabs } from '@/lib/dashboard-features'
import { Box } from '@boxlite-ai/api-client'
import { BoxInfoPanel } from './BoxInfoPanel'
import { BoxLogsTab } from './BoxLogsTab'
import { BoxMetricsTab } from './BoxMetricsTab'
import { BoxSpendingTab } from './BoxSpendingTab'
import { BoxTerminalTab } from './BoxTerminalTab'
import { BoxTracesTab } from './BoxTracesTab'
import { BoxVncTab } from './BoxVncTab'
import { TabValue } from './SearchParams'

interface BoxContentTabsProps {
  box: Box | undefined
  isLoading: boolean
  experimentsEnabled: boolean | undefined
  vncEnabled: boolean
  tab: TabValue
  onTabChange: (tab: TabValue) => void
}

export function BoxContentTabs({
  box,
  isLoading,
  experimentsEnabled,
  vncEnabled,
  tab,
  onTabChange,
}: BoxContentTabsProps) {
  const { getRegionName } = useRegions()
  const availableTabs = getBoxContentTabs({ experimentsEnabled, vncEnabled })

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-0 border-b border-border h-[41px] px-4 shrink-0">
          <Skeleton className="h-4 w-16 lg:hidden" />
          <Skeleton className="h-4 w-10 ml-4 lg:ml-0" />
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

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as TabValue)} className="flex flex-col h-full gap-0">
      <TabsList variant="underline" className="h-[41px] overflow-x-auto overflow-y-hidden scrollbar-sm">
        {availableTabs.includes('overview') && (
          <TabsTrigger value="overview" className="lg:hidden">
            Overview
          </TabsTrigger>
        )}
        {experimentsEnabled &&
          availableTabs.some((value) => ['logs', 'traces', 'metrics', 'spending'].includes(value)) && (
            <>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="traces">Traces</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
              <TabsTrigger value="spending">Spending</TabsTrigger>
            </>
          )}
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
        {availableTabs.includes('vnc') && <TabsTrigger value="vnc">VNC</TabsTrigger>}
      </TabsList>

      <TabsContent value="overview" className="flex-1 min-h-0 m-0 overflow-y-auto scrollbar-sm lg:hidden">
        <BoxInfoPanel box={box} getRegionName={getRegionName} />
      </TabsContent>
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
      <TabsContent value="terminal" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden">
        <BoxTerminalTab box={box} />
      </TabsContent>
      {availableTabs.includes('vnc') && (
        <TabsContent value="vnc" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col overflow-hidden">
          <BoxVncTab box={box} />
        </TabsContent>
      )}
    </Tabs>
  )
}
