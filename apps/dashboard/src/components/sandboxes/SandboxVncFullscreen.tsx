/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useSandboxQuery } from '@/hooks/queries/useSandboxQuery'
import { useSandboxWsSync } from '@/hooks/useSandboxWsSync'
import { Container } from 'lucide-react'
import { SandboxFullscreenShell } from './SandboxFullscreenShell'
import { SandboxVncTab } from './SandboxVncTab'

export default function SandboxVncFullscreen() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const { data: sandbox, isLoading, isError } = useSandboxQuery(sandboxId ?? '')
  useSandboxWsSync({ sandboxId })

  const label = sandbox?.name || sandbox?.id || sandboxId
  const backPath = sandboxId ? RoutePath.SANDBOX_DETAILS.replace(':sandboxId', sandboxId) : RoutePath.SANDBOXES

  return (
    <SandboxFullscreenShell
      sandboxId={sandboxId}
      title={label}
      copyValue={sandbox ? sandbox.name || sandbox.id : undefined}
    >
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Spinner className="size-4" />
          <span className="text-sm">Loading sandbox...</span>
        </div>
      ) : isError || !sandbox ? (
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
      ) : (
        <SandboxVncTab sandbox={sandbox} variant="fullscreen" />
      )}
    </SandboxFullscreenShell>
  )
}
