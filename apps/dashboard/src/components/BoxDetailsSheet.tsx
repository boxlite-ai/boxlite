/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBoxPublicId, getBoxPublicIdLabel, getBoxRouteId } from '@/lib/box-identity'
import { formatDuration, formatTimestamp, getRelativeTimeString } from '@/lib/utils'
import { Box, BoxState } from '@boxlite-ai/api-client'
import { Play, Tag, Trash, Wrench, X } from 'lucide-react'
import React, { useState } from 'react'
import { Link, generatePath } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { CopyButton } from './CopyButton'
import { ResourceChip } from './ResourceChip'
import { BoxState as BoxStateComponent } from './BoxTable/BoxState'
import { TimestampTooltip } from './TimestampTooltip'
import { LogsTab, TracesTab, MetricsTab } from './telemetry'
import { BoxSpendingTab } from './spending'
import { useFeatureFlagEnabled } from 'posthog-js/react'
import { FeatureFlags } from '@/enums/FeatureFlags'
import { useConfig } from '@/hooks/useConfig'

interface BoxDetailsSheetProps {
  box: Box | null
  open: boolean
  onOpenChange: (open: boolean) => void
  boxIsLoading: Record<string, boolean>
  handleStart: (id: string) => void
  handleStop: (id: string) => void
  handleDelete: (id: string) => void
  getWebTerminalUrl: (id: string) => Promise<string | null>
  writePermitted: boolean
  deletePermitted: boolean
  handleRecover: (id: string) => void
}

const BoxDetailsSheet: React.FC<BoxDetailsSheetProps> = ({
  box,
  open,
  onOpenChange,
  boxIsLoading,
  handleStart,
  handleStop,
  handleDelete,
  getWebTerminalUrl,
  writePermitted,
  deletePermitted,
  handleRecover,
}) => {
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null)
  const experimentsEnabled = useFeatureFlagEnabled(FeatureFlags.ORGANIZATION_EXPERIMENTS)
  const spendingEnabled = useFeatureFlagEnabled(FeatureFlags.BOX_SPENDING)
  const config = useConfig()
  const spendingTabAvailable = spendingEnabled && !!config.analyticsApiUrl

  // TODO: uncomment when we enable the terminal tab
  // useEffect(() => {
  //   const getTerminalUrl = async () => {
  //     if (!box?.id) {
  //       setTerminalUrl(null)
  //       return
  //     }

  //     const url = await getWebTerminalUrl(box.id)
  //     setTerminalUrl(url)
  //   }

  //   getTerminalUrl()
  // }, [box?.id, getWebTerminalUrl])

  if (!box) return null
  const publicBoxId = getBoxPublicId(box)

  const getLastEvent = (box: Box): { date: Date; relativeTimeString: string } => {
    return getRelativeTimeString(box.updatedAt)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-dvw sm:w-[800px] p-0 flex flex-col gap-0 [&>button]:hidden">
        <SheetHeader className="space-y-0 flex flex-row justify-between items-center  p-4 px-5 border-b border-border">
          <SheetTitle className="text-2xl font-medium">Box Details</SheetTitle>
          <div className="flex gap-2 items-center">
            <Button variant="link" asChild>
              <Link to={generatePath(RoutePath.BOX_DETAILS, { boxId: getBoxRouteId(box) })}>View</Link>
            </Button>
            {writePermitted && (
              <>
                {box.state === BoxState.STARTED && (
                  <Button variant="outline" onClick={() => handleStop(box.id)} disabled={boxIsLoading[box.id]}>
                    Stop
                  </Button>
                )}
                {box.state === BoxState.STOPPED && !box.recoverable && (
                  <Button variant="outline" onClick={() => handleStart(box.id)} disabled={boxIsLoading[box.id]}>
                    <Play className="w-4 h-4" />
                    Start
                  </Button>
                )}
                {box.state === BoxState.ERROR && box.recoverable && (
                  <Button variant="outline" onClick={() => handleRecover(box.id)} disabled={boxIsLoading[box.id]}>
                    <Wrench className="w-4 h-4" />
                    Recover
                  </Button>
                )}
              </>
            )}
            {deletePermitted && (
              <Button
                variant="outline"
                className="w-8 h-8"
                onClick={() => handleDelete(box.id)}
                disabled={boxIsLoading[box.id]}
              >
                <Trash className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="outline"
              className="w-8 h-8"
              onClick={() => onOpenChange(false)}
              disabled={boxIsLoading[box.id]}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </SheetHeader>

        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          {experimentsEnabled && (
            <TabsList className="mx-4 w-fit flex-shrink-0 bg-transparent border-b border-border rounded-none h-auto p-0 gap-0 mt-2">
              <TabsTrigger
                value="overview"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="logs"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2"
              >
                Logs
              </TabsTrigger>
              <TabsTrigger
                value="traces"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2"
              >
                Traces
              </TabsTrigger>
              <TabsTrigger
                value="metrics"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2"
              >
                Metrics
              </TabsTrigger>
              {spendingTabAvailable && (
                <TabsTrigger
                  value="spending"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2"
                >
                  Spending
                </TabsTrigger>
              )}
            </TabsList>
          )}

          <TabsContent value="overview" className="flex-1 p-6 space-y-10 overflow-y-auto min-h-0">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm text-muted-foreground">Name</h3>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{box.name}</p>
                  <CopyButton value={box.name} tooltipText="Copy name" size="icon-xs" />
                </div>
              </div>
              <div>
                <h3 className="text-sm text-muted-foreground">Box ID</h3>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-sm font-mono font-medium truncate">{getBoxPublicIdLabel(box)}</p>
                  {publicBoxId && <CopyButton value={publicBoxId} tooltipText="Copy Box ID" size="icon-xs" />}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <h3 className="text-sm text-muted-foreground">State</h3>
                <div className="mt-1 text-sm">
                  <BoxStateComponent state={box.state} errorReason={box.errorReason} recoverable={box.recoverable} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div>
                <h3 className="text-sm text-muted-foreground">Last event</h3>
                <p className="mt-1 text-sm font-medium">
                  <TimestampTooltip timestamp={box.updatedAt}>{getLastEvent(box).relativeTimeString}</TimestampTooltip>
                </p>
              </div>
              <div>
                <h3 className="text-sm text-muted-foreground">Created at</h3>
                <p className="mt-1 text-sm font-medium">
                  <TimestampTooltip timestamp={box.createdAt}>{formatTimestamp(box.createdAt)}</TimestampTooltip>
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div>
                <h3 className="text-sm text-muted-foreground">Auto-stop</h3>
                <p className="mt-1 text-sm font-medium">
                  {box.autoStopInterval ? formatDuration(box.autoStopInterval) : 'Disabled'}
                </p>
              </div>
              <div>
                <h3 className="text-sm text-muted-foreground">Auto-delete</h3>
                <p className="mt-1 text-sm font-medium">
                  {box.autoDeleteInterval !== undefined && box.autoDeleteInterval >= 0
                    ? box.autoDeleteInterval === 0
                      ? 'On stop'
                      : formatDuration(box.autoDeleteInterval)
                    : 'Disabled'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1">
              <div>
                <h3 className="text-sm text-muted-foreground">Resources</h3>
                <div className="mt-1 text-sm font-medium flex items-center gap-1 flex-wrap">
                  <ResourceChip resource="cpu" value={box.cpu} />
                  <ResourceChip resource="memory" value={box.memory} />
                  <ResourceChip resource="disk" value={box.disk} />
                </div>
              </div>
            </div>
            <div>
              <h3 className="text-lg font-medium">Labels</h3>
              <div className="mt-3 space-y-4">
                {Object.entries(box.labels ?? {}).length > 0 ? (
                  Object.entries(box.labels ?? {}).map(([key, value]) => (
                    <div key={key} className="text-sm">
                      <div>{key}</div>
                      <div className="font-medium p-2 bg-muted rounded-md mt-1 border border-border">{value}</div>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col border border-border rounded-md items-center justify-center gap-2 text-muted-foreground w-full min-h-40">
                    <Tag className="w-4 h-4" />
                    <span className="text-sm">No labels found</span>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="terminal" className="p-4">
            <iframe title="Terminal" src={terminalUrl || undefined} className="w-full h-full"></iframe>
          </TabsContent>

          <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden">
            <LogsTab boxId={box.id} />
          </TabsContent>

          <TabsContent value="traces" className="flex-1 min-h-0 overflow-hidden">
            <TracesTab boxId={box.id} />
          </TabsContent>

          <TabsContent value="metrics" className="flex-1 min-h-0 overflow-hidden">
            <MetricsTab boxId={box.id} />
          </TabsContent>

          {spendingTabAvailable && (
            <TabsContent value="spending" className="flex-1 min-h-0 overflow-hidden">
              <BoxSpendingTab boxId={box.id} />
            </TabsContent>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

export default BoxDetailsSheet
