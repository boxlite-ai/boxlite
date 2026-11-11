/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { getBoxDisplayName, getBoxPublicId } from '@/lib/box-identity'
import { Container } from '@/components/ui/icon'
import { usePageTitle } from '@/hooks/usePageTitle'
import { BoxFullscreenShell } from './BoxFullscreenShell'
import { BoxTerminalSession } from './BoxTerminalSession'
import { BoxPageNavigation } from './BoxPageNavigation'

export default function BoxTerminalFullscreen() {
  const { boxId } = useParams<{ boxId: string }>()
  const { data: box, isLoading: boxLoading, isError: boxIsError } = useBoxQuery(boxId ?? '')
  useBoxWsSync({ boxId })

  usePageTitle(box ? `${getBoxDisplayName(box)} · Terminal` : 'Box terminal')
  const backPath = boxId ? RoutePath.BOX_DETAILS.replace(':boxId', boxId) : RoutePath.BOXES

  let body: ReactNode
  if (boxLoading) {
    body = (
      <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
        <Spinner className="size-4" />
        <span className="text-body">Loading box...</span>
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
  } else {
    body = <BoxTerminalSession box={box} />
  }

  const label = box ? getBoxDisplayName(box) : boxId
  const publicBoxId = box ? getBoxPublicId(box) : ''

  return (
    <BoxFullscreenShell boxId={boxId} title={label} copyValue={publicBoxId || undefined}>
      {boxId && <BoxPageNavigation boxId={boxId} current="terminal" className="px-3" />}
      {body}
    </BoxFullscreenShell>
  )
}
