/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { RoutePath } from '@/enums/RoutePath'
import { ArrowLeft } from 'lucide-react'
import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

interface SandboxFullscreenShellProps {
  sandboxId?: string
  title?: string
  copyValue?: string
  children: ReactNode
}

export function SandboxFullscreenShell({ sandboxId, title, copyValue, children }: SandboxFullscreenShellProps) {
  const navigate = useNavigate()

  const handleBack = () => {
    navigate(sandboxId ? RoutePath.SANDBOX_DETAILS.replace(':sandboxId', sandboxId) : RoutePath.SANDBOXES)
  }

  return (
    <div className="flex h-[var(--app-content-height,calc(100svh_-_3.5rem))] flex-col bg-background">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={handleBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 truncate text-sm font-medium">{title || sandboxId || 'Sandbox'}</h1>
        {copyValue && <CopyButton value={copyValue} tooltipText="Copy" size="icon-xs" />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
