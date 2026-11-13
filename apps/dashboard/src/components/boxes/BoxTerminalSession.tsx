/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isStartable, isStoppable } from '@/lib/utils/box'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { TerminalSquare } from '@/components/ui/icon'
import { BoxTerminal } from './BoxTerminal'
import { getBoxDisplayName } from '@/lib/box-identity'

export function BoxTerminalSession({ box }: { box: Box }) {
  const running = isStoppable(box)
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  if (!running) {
    return (
      <div className="flex-1 flex flex-col p-2 sm:p-4">
        <div className="flex-1 min-h-0 flex">
          <Empty className="border-0 bg-transparent">
            <EmptyHeader>
              <EmptyMedia>
                <TerminalSquare className="size-9 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>Box is not running</EmptyTitle>
              <EmptyDescription>
                {writePermitted && isStartable(box)
                  ? 'Use Start above to open a terminal.'
                  : 'The terminal is available when this Box is running.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    )
  }

  return <BoxTerminal boxId={box.id} boxName={getBoxDisplayName(box)} className="flex-1" />
}
