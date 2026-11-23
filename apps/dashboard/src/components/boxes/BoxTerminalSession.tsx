/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isStartable, isStoppable } from '@/lib/utils/box'
import { Box, BoxState, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Play, RefreshCw, TerminalSquare } from '@/components/ui/icon'
import { BoxTerminal } from './BoxTerminal'
import { getBoxDisplayName } from '@/lib/box-identity'

export function BoxTerminalSession({
  box,
  onStart,
  startDisabled,
  starting,
  startFailed,
}: {
  box: Box
  onStart: () => Promise<void>
  startDisabled: boolean
  starting: boolean
  startFailed: boolean
}) {
  const running = isStoppable(box)
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  if (!running) {
    const waitingForStart = starting || box.state === BoxState.STARTING
    return (
      <Empty className="flex-none border-0 bg-transparent py-12" aria-busy={waitingForStart}>
        <EmptyHeader>
          <EmptyMedia>
            {waitingForStart ? (
              <RefreshCw className="size-9 animate-spin text-muted-foreground" />
            ) : (
              <TerminalSquare className="size-9 text-muted-foreground" />
            )}
          </EmptyMedia>
          <EmptyTitle>{waitingForStart ? 'Starting Box…' : 'Box is not running'}</EmptyTitle>
          <EmptyDescription>
            {waitingForStart
              ? 'The terminal will connect when this Box is running.'
              : isStartable(box)
                ? writePermitted
                  ? 'Start this Box to use the terminal.'
                  : 'Ask an organization member with permission to start this Box.'
                : 'The terminal is available when this Box is running.'}
          </EmptyDescription>
        </EmptyHeader>
        {writePermitted && isStartable(box) && (
          <Button onClick={onStart} disabled={startDisabled}>
            <Play className="size-4" /> Start Box
          </Button>
        )}
        {startFailed && !waitingForStart && (
          <p role="alert" className="max-w-sm text-body text-destructive">
            Could not start this Box. Check the error notification for details, then try again.
          </p>
        )}
      </Empty>
    )
  }

  return <BoxTerminal boxId={box.id} boxName={getBoxDisplayName(box)} className="flex-1" />
}
