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
import { useSandboxQuery } from '@/hooks/queries/useSandboxQuery'
import { useTerminalSessionQuery } from '@/hooks/queries/useTerminalSessionQuery'
import { useSandboxSessionContext } from '@/hooks/useSandboxSessionContext'
import { useSandboxWsSync } from '@/hooks/useSandboxWsSync'
import { isStoppable } from '@/lib/utils/sandbox'
import { Container, Play, RefreshCw, TerminalSquare } from 'lucide-react'
import { SandboxFullscreenShell } from './SandboxFullscreenShell'
import { SandboxTerminalFrame } from './SandboxTerminalFrame'

export default function SandboxTerminalFullscreen() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const { data: sandbox, isLoading: sandboxLoading, isError: sandboxIsError } = useSandboxQuery(sandboxId ?? '')
  useSandboxWsSync({ sandboxId })

  const running = sandbox ? isStoppable(sandbox) : false
  const { isTerminalActivated, activateTerminal } = useSandboxSessionContext()
  const [activated, setActivated] = useState(() => (sandboxId ? isTerminalActivated(sandboxId) : false))

  // Carry session activation across remounts
  useEffect(() => {
    if (sandboxId && isTerminalActivated(sandboxId)) setActivated(true)
  }, [sandboxId, isTerminalActivated])

  const {
    data: session,
    isLoading: sessionLoading,
    isError: sessionError,
    isFetching,
    reset,
  } = useTerminalSessionQuery(sandboxId ?? '', running && activated)

  const handleConnect = () => {
    if (!sandboxId) return
    activateTerminal(sandboxId)
    setActivated(true)
  }

  const backPath = sandboxId ? RoutePath.SANDBOX_DETAILS.replace(':sandboxId', sandboxId) : RoutePath.SANDBOXES

  let body: ReactNode
  if (sandboxLoading) {
    body = (
      <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
        <Spinner className="size-4" />
        <span className="text-sm">Loading sandbox...</span>
      </div>
    )
  } else if (sandboxIsError || !sandbox) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Container className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Sandbox not found</EmptyTitle>
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
          <EmptyTitle>Sandbox is not running</EmptyTitle>
          <EmptyDescription>Start the sandbox to access the terminal.</EmptyDescription>
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
          <EmptyDescription>Connect to an interactive terminal session in your sandbox.</EmptyDescription>
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
    body = <SandboxTerminalFrame sessionUrl={session.url} className="flex-1" />
  }

  const label = sandbox?.name || sandbox?.id || sandboxId

  return (
    <SandboxFullscreenShell
      sandboxId={sandboxId}
      title={label}
      copyValue={sandbox ? sandbox.name || sandbox.id : undefined}
    >
      {body}
    </SandboxFullscreenShell>
  )
}
