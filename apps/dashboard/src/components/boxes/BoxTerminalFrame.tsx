/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Maximize2 } from '@/components/ui/icon'
import { useEffect, useRef, type SyntheticEvent } from 'react'
import { Link } from 'react-router-dom'
import { buildTerminalIframeSrc, registerActiveTerminalFrame } from './terminalIframeSrc'

interface BoxTerminalFrameProps {
  sessionUrl: string
  fullscreenHref?: string
  className?: string
}

export function BoxTerminalFrame({ sessionUrl, fullscreenHref, className }: BoxTerminalFrameProps) {
  const deregisterRef = useRef<(() => void) | null>(null)
  const iframeSrc = buildTerminalIframeSrc(sessionUrl)

  const handleLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget.contentWindow
    if (!frame) return
    deregisterRef.current?.()
    deregisterRef.current = registerActiveTerminalFrame(frame, sessionUrl)
  }

  useEffect(() => {
    return () => {
      deregisterRef.current?.()
      deregisterRef.current = null
    }
  }, [])

  return (
    <div className={cn('relative min-h-0 bg-black', className)}>
      <iframe
        title="Box terminal"
        src={iframeSrc}
        onLoad={handleLoad}
        className="absolute inset-0 h-full w-full border-0 bg-black"
      />
      {/* Native Cmd/Ctrl+V pastes into the terminal, so no dedicated paste button. */}
      {fullscreenHref && (
        <Button
          asChild
          variant="secondary"
          size="icon-sm"
          className="absolute right-2 top-2 opacity-60 hover:opacity-100"
          title="Fullscreen"
        >
          <Link to={fullscreenHref} aria-label="Open terminal fullscreen">
            <Maximize2 className="size-4" />
          </Link>
        </Button>
      )}
    </div>
  )
}
