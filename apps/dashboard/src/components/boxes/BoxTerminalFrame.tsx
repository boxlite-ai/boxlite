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
    <div className={cn('relative min-h-0 bg-[#0c0e12]', className)}>
      {/* An 8px border — colored to match the terminal bg — keeps the content
          off the edge without touching the layout. The iframe must keep
          inset-0 + h/w-full (it's a replaced element, so left/right insets
          alone don't stretch it), and its border shrinks the inner viewport so
          xterm's FitAddon reflows columns to the padded area. */}
      <iframe
        title="Box terminal"
        src={iframeSrc}
        onLoad={handleLoad}
        className="absolute inset-0 h-full w-full border-8 border-[#0c0e12]"
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
