/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { getBoxDisplayName, getBoxPublicId } from '@/lib/box-identity'
import { Container } from 'lucide-react'
import { BoxFullscreenShell } from './BoxFullscreenShell'
import { BoxVncTab } from './BoxVncTab'

export default function BoxVncFullscreen() {
  const { boxId } = useParams<{ boxId: string }>()
  const { data: box, isLoading, isError } = useBoxQuery(boxId ?? '')
  useBoxWsSync({ boxId })

  const label = box ? getBoxDisplayName(box) : boxId
  const backPath = boxId ? RoutePath.BOX_DETAILS.replace(':boxId', boxId) : RoutePath.BOXES
  const publicBoxId = box ? getBoxPublicId(box) : ''

  return (
    <BoxFullscreenShell boxId={boxId} title={label} copyValue={publicBoxId || undefined}>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="text-sm">Loading box...</span>
        </div>
      ) : isError || !box ? (
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
      ) : (
        <BoxVncTab box={box} variant="fullscreen" />
      )}
    </BoxFullscreenShell>
  )
}
