/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Maximize2, Minimize2 } from '@/components/ui/icon'
import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { buildTerminalIframeSrc, registerActiveTerminalFrame } from './terminalIframeSrc'

interface BoxTerminalFrameProps {
  sessionUrl: string
  expandable?: boolean
  className?: string
  onCurrentDirChange?: (path: string) => void
}

export function BoxTerminalFrame({
  sessionUrl,
  expandable = false,
  className,
  onCurrentDirChange,
}: BoxTerminalFrameProps) {
  const deregisterRef = useRef<(() => void) | null>(null)
  const [expanded, setExpanded] = useState(false)
  const iframeSrc = buildTerminalIframeSrc(sessionUrl)

  const handleLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = event.currentTarget.contentWindow
    if (!frame) return
    deregisterRef.current?.()
    deregisterRef.current = registerActiveTerminalFrame(frame, sessionUrl, { onCurrentDirChange })
  }

  useEffect(() => {
    return () => {
      deregisterRef.current?.()
      deregisterRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!expanded) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [expanded])

  return (
    <div
      className={cn(
        'relative min-h-0 bg-black',
        expanded ? 'fixed inset-0 z-50 h-[100svh] w-screen' : className,
      )}
    >
      <iframe
        title="Box terminal"
        src={iframeSrc}
        onLoad={handleLoad}
        className="absolute inset-0 h-full w-full border-0 bg-black"
      />
      {/* Native Cmd/Ctrl+V pastes into the terminal, so no dedicated paste button. */}
      {expandable && (
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className={cn(
            'absolute opacity-75 shadow-lg hover:opacity-100',
            expanded ? 'right-10 top-4 size-11 border border-border/80' : 'right-4 top-2',
          )}
          title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={expanded ? 'Exit terminal fullscreen' : 'Open terminal fullscreen'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 className="size-5" /> : <Maximize2 className="size-4" />}
        </Button>
      )}
    </div>
  )
}
