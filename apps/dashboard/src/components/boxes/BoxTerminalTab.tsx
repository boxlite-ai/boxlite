/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { BOXLITE_DOCS_URL } from '@/constants/ExternalLinks'
import { RoutePath } from '@/enums/RoutePath'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useTerminalSessionQuery } from '@/hooks/queries/useTerminalSessionQuery'
import { useBoxSessionContext } from '@/hooks/useBoxSessionContext'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxRouteId } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { isStoppable } from '@/lib/utils/box'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Spinner } from '@/components/ui/spinner'
import { Play, RefreshCw, TerminalSquare } from '@/components/ui/icon'
import { toast } from 'sonner'
import { BoxTerminalFrame } from './BoxTerminalFrame'

export function BoxTerminalTab({ box }: { box: Box }) {
  const running = isStoppable(box)
  const { isTerminalActivated, activateTerminal } = useBoxSessionContext()
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const startMutation = useStartBoxMutation()

  const handleStart = async () => {
    try {
      await startMutation.mutateAsync({ boxId: box.id, detailRef: getBoxRouteId(box) })
      toast.success('Box started')
    } catch (error) {
      handleApiError(error, 'Failed to start box')
    }
  }

  const [activated, setActivated] = useState(() => isTerminalActivated(box.id))

  const { data: session, isLoading, isError, isFetching, reset } = useTerminalSessionQuery(box.id, running && activated)

  const handleConnect = () => {
    activateTerminal(box.id)
    setActivated(true)
  }

  if (!running) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <TerminalSquare className="size-12 text-muted-foreground" />
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
            {writePermitted && (
              <Button onClick={handleStart} disabled={startMutation.isPending}>
                {startMutation.isPending ? <Spinner className="size-4" /> : <Play className="size-4" />}
                Start box
              </Button>
            )}
          </Empty>
        </div>
      </div>
    )
  }

  // Not yet activated - show connect button
  if (!activated) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 flex">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <TerminalSquare className="size-12 text-muted-foreground" />
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
        <div className="flex-1 min-h-0 flex items-center justify-center gap-2 text-muted-foreground">
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
        <div className="flex-1 min-h-0 flex">
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
    <div className="flex-1 flex flex-col">
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
        <BoxTerminalFrame sessionUrl={session.url} fullscreenHref={fullscreenHref} className="h-full" />
      </div>
    </div>
  )
}
