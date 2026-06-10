/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { BOXLITE_DOCS_URL } from '@/constants/ExternalLinks'
import { RoutePath } from '@/enums/RoutePath'
import { useTerminalSessionQuery } from '@/hooks/queries/useTerminalSessionQuery'
import { useBoxSessionContext } from '@/hooks/useBoxSessionContext'
import { getBoxRouteId } from '@/lib/box-identity'
import { isStoppable } from '@/lib/utils/box'
import { Box } from '@boxlite-ai/api-client'
import { Spinner } from '@/components/ui/spinner'
import { Play, RefreshCw, TerminalSquare } from 'lucide-react'
import { BoxTerminalFrame } from './BoxTerminalFrame'

export function BoxTerminalTab({ box }: { box: Box }) {
  const running = isStoppable(box)
  const { isTerminalActivated, activateTerminal } = useBoxSessionContext()

  const [activated, setActivated] = useState(() => isTerminalActivated(box.id))

  const { data: session, isLoading, isError, isFetching, reset } = useTerminalSessionQuery(box.id, running && activated)

  const handleConnect = () => {
    activateTerminal(box.id)
    setActivated(true)
  }

  if (!running) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 rounded-md border border-border flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TerminalSquare className="size-4" />
              </EmptyMedia>
              <EmptyTitle>Box is not running</EmptyTitle>
              <EmptyDescription>
                Start the box to access the terminal.{' '}
                <a href={`${BOXLITE_DOCS_URL}/en/web-terminal`} target="_blank" rel="noopener noreferrer">
                  Learn more
                </a>
                .
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    )
  }

  // Not yet activated - show connect button
  if (!activated) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 rounded-md border border-border flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TerminalSquare className="size-4" />
              </EmptyMedia>
              <EmptyTitle>Terminal</EmptyTitle>
              <EmptyDescription>
                Connect to an interactive terminal session in your box.{' '}
                <a href={`${BOXLITE_DOCS_URL}/en/web-terminal`} target="_blank" rel="noopener noreferrer">
                  Learn more
                </a>
                .
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={handleConnect}>
              <Play className="size-4" />
              Connect
            </Button>
          </Empty>
        </div>
      </div>
    )
  }

  // Loading / fetching
  if (isLoading || isFetching) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 rounded-md border border-border flex items-center justify-center gap-2 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="text-sm">Connecting...</span>
        </div>
      </div>
    )
  }

  // Error
  if (isError || !session) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 rounded-md border border-border flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>Failed to connect</EmptyTitle>
              <EmptyDescription>Something went wrong while connecting to the terminal.</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={() => reset()}>
              <RefreshCw className="size-4" />
              Retry
            </Button>
          </Empty>
        </div>
      </div>
    )
  }

  // Active session
  const fullscreenHref = RoutePath.BOX_TERMINAL.replace(':boxId', getBoxRouteId(box))
  return (
    <div className="flex-1 flex flex-col p-2 sm:p-4">
      <div className="relative flex-1 min-h-0 rounded-md border border-border bg-black overflow-hidden p-1">
        <BoxTerminalFrame sessionUrl={session.url} fullscreenHref={fullscreenHref} className="h-full" />
      </div>
    </div>
  )
}
