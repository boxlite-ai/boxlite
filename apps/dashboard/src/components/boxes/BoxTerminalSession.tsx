/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxDisplayName, getBoxRouteId } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { isStartable, isStoppable } from '@/lib/utils/box'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Spinner } from '@/components/ui/spinner'
import { Play, TerminalSquare } from '@/components/ui/icon'
import { toast } from 'sonner'
import { BoxTerminal } from './BoxTerminal'

export function BoxTerminalSession({ box }: { box: Box }) {
  const running = isStoppable(box)
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
            {writePermitted && isStartable(box) && (
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

  return <BoxTerminal boxId={box.id} boxName={getBoxDisplayName(box)} className="flex-1" />
}
