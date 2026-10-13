/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RoutePath } from '@/enums/RoutePath'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useBoxSessionContext } from '@/hooks/useBoxSessionContext'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxRouteId } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { isStoppable } from '@/lib/utils/box'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Spinner } from '@/components/ui/spinner'
import { Play, TerminalSquare } from '@/components/ui/icon'
import { toast } from 'sonner'
import { BoxTerminal } from './BoxTerminal'

export function BoxTerminalTab({ box, refreshSignal = 0 }: { box: Box; refreshSignal?: number }) {
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
              <EmptyDescription>Start the box to access the terminal.</EmptyDescription>
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

  // Not yet activated. The panel already looks like a terminal, so the way in
  // is a prompt line, not a poster with an icon and a paragraph.
  if (!activated) {
    return (
      <div className="flex flex-1 flex-col p-5 font-mono text-body">
        <button
          type="button"
          onClick={handleConnect}
          className="group flex w-full items-center gap-3 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="text-brand">&gt;</span>
          <span>
            connect to <span className="text-foreground">{box.name ?? box.id}</span>
          </span>
          <span
            className="ml-1 inline-block h-[14px] w-[7px] bg-brand/70 group-hover:bg-brand"
            style={{ animation: 'blink 1.1s steps(1) infinite' }}
          />
        </button>
        <p className="mt-3 text-meta text-muted-foreground/70">opens an interactive shell inside the box</p>
      </div>
    )
  }

  // Active session
  const fullscreenHref = RoutePath.BOX_TERMINAL.replace(':boxId', getBoxRouteId(box))
  return (
    <div className="flex-1 flex flex-col">
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden">
        {/* A refresh reconnects: the key change mounts a fresh shell. */}
        <BoxTerminal key={refreshSignal} boxId={box.id} fullscreenHref={fullscreenHref} className="h-full" />
      </div>
    </div>
  )
}
