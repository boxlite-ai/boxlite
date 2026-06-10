/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useTerminalSessionQuery } from '@/hooks/queries/useTerminalSessionQuery'
import { useBoxSessionContext } from '@/hooks/useBoxSessionContext'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { getBoxDisplayName, getBoxPublicId } from '@/lib/box-identity'
import { isStoppable } from '@/lib/utils/box'
import { Container, Play, RefreshCw, TerminalSquare } from 'lucide-react'
import { BoxFullscreenShell } from './BoxFullscreenShell'
import { BoxTerminalFrame } from './BoxTerminalFrame'

export default function BoxTerminalFullscreen() {
  const { boxId } = useParams<{ boxId: string }>()
  const { data: box, isLoading: boxLoading, isError: boxIsError } = useBoxQuery(boxId ?? '')
  useBoxWsSync({ boxId })

  const running = box ? isStoppable(box) : false
  const { isTerminalActivated, activateTerminal } = useBoxSessionContext()
  const [activated, setActivated] = useState(() => (boxId ? isTerminalActivated(boxId) : false))

  // Carry session activation across remounts
  useEffect(() => {
    if (boxId && isTerminalActivated(boxId)) setActivated(true)
  }, [boxId, isTerminalActivated])

  const {
    data: session,
    isLoading: sessionLoading,
    isError: sessionError,
    isFetching,
    reset,
  } = useTerminalSessionQuery(boxId ?? '', running && activated)

  const handleConnect = () => {
    if (!boxId) return
    activateTerminal(boxId)
    setActivated(true)
  }

  const backPath = boxId ? RoutePath.BOX_DETAILS.replace(':boxId', boxId) : RoutePath.BOXES

  let body: ReactNode
  if (boxLoading) {
    body = (
      <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
        <Spinner className="size-4" />
        <span className="text-sm">Loading box...</span>
      </div>
    )
  } else if (boxIsError || !box) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Container className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Box not found</EmptyTitle>
          <EmptyDescription>Are you sure you're in the right organization?</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" asChild>
          <Link to={backPath}>Back</Link>
        </Button>
      </Empty>
    )
  } else if (!running) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquare className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Box is not running</EmptyTitle>
          <EmptyDescription>Start the box to access the terminal.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" asChild>
          <Link to={backPath}>Back</Link>
        </Button>
      </Empty>
    )
  } else if (!activated) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquare className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Terminal</EmptyTitle>
          <EmptyDescription>Connect to an interactive terminal session in your box.</EmptyDescription>
        </EmptyHeader>
        <Button onClick={handleConnect}>
          <Play className="size-4" />
          Connect
        </Button>
      </Empty>
    )
  } else if (sessionLoading || isFetching) {
    body = (
      <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
        <Spinner className="size-4" />
        <span className="text-sm">Connecting...</span>
      </div>
    )
  } else if (sessionError || !session) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Failed to connect</EmptyTitle>
          <EmptyDescription>Something went wrong while connecting to the terminal.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => reset()}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </Empty>
    )
  } else {
    body = <BoxTerminalFrame sessionUrl={session.url} className="flex-1" />
  }

  const label = box ? getBoxDisplayName(box) : boxId
  const publicBoxId = box ? getBoxPublicId(box) : ''

  return (
    <BoxFullscreenShell boxId={boxId} title={label} copyValue={publicBoxId || undefined}>
      {body}
    </BoxFullscreenShell>
  )
}
