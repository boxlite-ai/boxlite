/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { BOXLITE_DOCS_URL } from '@/constants/ExternalLinks'
import { RoutePath } from '@/enums/RoutePath'
import { useStartVncMutation } from '@/hooks/mutations/useStartVncMutation'
import { useVncInitialStatusQuery, useVncPollStatusQuery } from '@/hooks/queries/useVncStatusQuery'
import { useVncSessionQuery } from '@/hooks/queries/useVncSessionQuery'
import { cn } from '@/lib/utils'
import { isStoppable } from '@/lib/utils/sandbox'
import { Sandbox } from '@boxlite-ai/api-client'
import { Spinner } from '@/components/ui/spinner'
import { Maximize2, Monitor, Play, RefreshCw } from 'lucide-react'
import { type ReactNode } from 'react'

const VNC_MISSING_DEPS_MSG = 'Computer-use functionality is not available'

export function SandboxVncTab({ sandbox, variant = 'tab' }: { sandbox: Sandbox; variant?: 'tab' | 'fullscreen' }) {
  const running = isStoppable(sandbox)
  const fullscreen = variant === 'fullscreen'

  const renderPanel = (children: ReactNode, className?: string) => (
    <div className={cn('flex flex-1 flex-col', !fullscreen && 'p-2 sm:p-4')}>
      <div className={cn('flex min-h-0 flex-1', !fullscreen && 'rounded-md border border-border', className)}>
        {children}
      </div>
    </div>
  )

  // 1. Check initial VNC availability & status
  const initialStatusQuery = useVncInitialStatusQuery(sandbox.id, running)

  const isMissingDeps = (initialStatusQuery.error as Error | null)?.message === VNC_MISSING_DEPS_MSG
  const alreadyActive = initialStatusQuery.data === 'active'

  // 2. Start VNC
  const startMutation = useStartVncMutation(sandbox.id)

  const startError = startMutation.error?.message
  const startMissingDeps = startError === VNC_MISSING_DEPS_MSG

  // 3. Poll until active after starting
  const pollStatusQuery = useVncPollStatusQuery(sandbox.id, startMutation.isSuccess)

  const vncReady = alreadyActive || pollStatusQuery.data === 'active'

  // 4. Get signed URL once ready
  const {
    data: session,
    isLoading: sessionLoading,
    isError: sessionError,
    reset,
  } = useVncSessionQuery(sandbox.id, vncReady)

  const isStarting =
    startMutation.isPending ||
    (startMutation.isSuccess && !pollStatusQuery.data && !pollStatusQuery.error) ||
    (vncReady && sessionLoading)

  const unavailable = isMissingDeps || startMissingDeps
  const pollError = pollStatusQuery.error?.message
  const anyError = startError && !startMissingDeps ? startError : pollError

  if (!running) {
    return renderPanel(
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Monitor className="size-4" />
          </EmptyMedia>
          <EmptyTitle>Sandbox is not running</EmptyTitle>
          <EmptyDescription>
            Start the sandbox to access the VNC desktop.{' '}
            <a href={`${BOXLITE_DOCS_URL}/en/vnc-access`} target="_blank" rel="noopener noreferrer">
              Learn more
            </a>
            .
          </EmptyDescription>
        </EmptyHeader>
      </Empty>,
    )
  }

  if (initialStatusQuery.isLoading) {
    return renderPanel(
      <>
        <Spinner className="size-4" />
        <span className="text-sm">Checking VNC status...</span>
      </>,
      'items-center justify-center gap-2 text-muted-foreground',
    )
  }

  if (unavailable) {
    return renderPanel(
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Monitor className="size-4" />
          </EmptyMedia>
          <EmptyTitle>VNC not available</EmptyTitle>
          <EmptyDescription>
            Computer-use dependencies are not installed in this sandbox.{' '}
            <a href={`${BOXLITE_DOCS_URL}/en/vnc-access`} target="_blank" rel="noopener noreferrer">
              Read the setup guide
            </a>
            .
          </EmptyDescription>
        </EmptyHeader>
      </Empty>,
    )
  }

  // Not yet started - show start button
  if (!vncReady && !isStarting) {
    return renderPanel(
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Monitor className="size-4" />
          </EmptyMedia>
          <EmptyTitle>VNC Desktop</EmptyTitle>
          <EmptyDescription>
            Start the VNC server to access a graphical desktop.{' '}
            <a href={`${BOXLITE_DOCS_URL}/en/vnc-access`} target="_blank" rel="noopener noreferrer">
              Learn more
            </a>
            .
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={() => startMutation.mutate()}>
          <Play className="size-4" />
          Start VNC
        </Button>
      </Empty>,
    )
  }

  // Starting / polling / getting URL
  if (isStarting) {
    return renderPanel(
      <>
        <Spinner className="size-4" />
        <span className="text-sm">
          {startMutation.isPending
            ? 'Starting VNC desktop...'
            : vncReady && sessionLoading
              ? 'Getting preview URL...'
              : 'Waiting for VNC to become ready...'}
        </span>
      </>,
      'items-center justify-center gap-2 bg-neutral-950 text-muted-foreground',
    )
  }

  // Error
  if (anyError || sessionError) {
    return renderPanel(
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyTitle>Failed to connect</EmptyTitle>
          <EmptyDescription>{anyError || 'Something went wrong while connecting to VNC.'}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={reset}>
          <RefreshCw className="size-4" />
          Retry
        </Button>
      </Empty>,
    )
  }

  // Active session
  if (session) {
    const fullscreenHref = RoutePath.SANDBOX_VNC.replace(':sandboxId', sandbox.id)
    return renderPanel(
      <>
        <iframe
          title="VNC desktop"
          src={`${session.url}/vnc.html?autoconnect=true&resize=scale`}
          className="h-full w-full border-0"
        />
        {!fullscreen && (
          <Button
            asChild
            variant="secondary"
            size="icon-sm"
            className="absolute right-2 top-2 opacity-60 hover:opacity-100"
            title="Fullscreen"
          >
            <Link to={fullscreenHref} aria-label="Open VNC fullscreen">
              <Maximize2 className="size-4" />
            </Link>
          </Button>
        )}
      </>,
      'relative overflow-hidden bg-neutral-950',
    )
  }

  return null
}
