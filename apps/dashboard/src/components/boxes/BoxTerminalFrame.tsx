/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Maximize2, Minimize2, Tv } from '@/components/ui/icon'
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { buildTerminalIframeSrc, registerActiveTerminalFrame } from './terminalIframeSrc'

interface BoxTerminalFrameProps {
  sessionUrl: string
  expandable?: boolean
  className?: string
  onCurrentDirChange?: (path: string) => void
}

// Retro mode is a per-browser preference (like the terminal font size), so it
// persists across boxes and reloads. Off by default — color is the norm.
const RETRO_STORAGE_KEY = 'boxlite.terminal.retro'

function readRetroPref(): boolean {
  try {
    return window.localStorage.getItem(RETRO_STORAGE_KEY) === '1'
  } catch {
    return false
  }
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
  const [retro, setRetro] = useState(readRetroPref)

  const toggleRetro = useCallback(() => {
    setRetro((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(RETRO_STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* localStorage may be blocked; the toggle still works for this session. */
      }
      return next
    })
  }, [])

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
        'relative min-h-0 bg-[#0c0e12]',
        expanded ? 'fixed inset-0 z-50 h-[100svh] w-screen' : className,
      )}
    >
      {/* An 8px border — colored to match the terminal bg — keeps the content
          off the edge without touching the layout. The iframe must keep
          inset-0 + h/w-full (it's a replaced element, so left/right insets
          alone don't stretch it), and its border shrinks the inner viewport so
          xterm's FitAddon reflows columns to the padded area.

          Retro mode is a pure client-side grayscale filter on the composited
          iframe pixels — it does NOT change what the box emits (color codes
          still flow), so it works cross-origin and needs no session restart. */}
      <iframe
        title="Box terminal"
        src={iframeSrc}
        onLoad={handleLoad}
        className={cn(
          'absolute inset-0 h-full w-full border-8 border-[#0c0e12] transition-[filter] duration-150',
          retro && 'grayscale',
        )}
      />
      {/* Native Cmd/Ctrl+V pastes into the terminal, so no dedicated paste button. */}
      <div className={cn('absolute flex gap-1', expanded ? 'right-10 top-4' : 'right-2 top-2')}>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          onClick={toggleRetro}
          aria-pressed={retro}
          title={retro ? 'Retro mode on — monochrome (click for color)' : 'Retro mode off — color (click for monochrome)'}
          className={cn('opacity-75 shadow-lg hover:opacity-100', expanded && 'size-11 border border-border/80', retro && 'text-brand opacity-100')}
        >
          <Tv className={cn(expanded ? 'size-5' : 'size-4')} />
        </Button>
        {expandable && (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className={cn('opacity-75 shadow-lg hover:opacity-100', expanded && 'size-11 border border-border/80')}
            title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={expanded ? 'Exit terminal fullscreen' : 'Open terminal fullscreen'}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 className="size-5" /> : <Maximize2 className="size-4" />}
          </Button>
        )}
      </div>
    </div>
  )
}
