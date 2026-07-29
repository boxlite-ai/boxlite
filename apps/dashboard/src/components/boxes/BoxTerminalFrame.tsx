/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Maximize2, Tv } from '@/components/ui/icon'
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Link } from 'react-router-dom'
import { buildTerminalIframeSrc, registerActiveTerminalFrame } from './terminalIframeSrc'

interface BoxTerminalFrameProps {
  sessionUrl: string
  fullscreenHref?: string
  className?: string
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

export function BoxTerminalFrame({ sessionUrl, fullscreenHref, className }: BoxTerminalFrameProps) {
  const deregisterRef = useRef<(() => void) | null>(null)
  const iframeSrc = buildTerminalIframeSrc(sessionUrl)
  const [retro, setRetro] = useState(readRetroPref)

  useEffect(() => {
    try {
      window.localStorage.setItem(RETRO_STORAGE_KEY, retro ? '1' : '0')
    } catch {
      /* localStorage may be blocked; the toggle still works for this session. */
    }
  }, [retro])

  const toggleRetro = useCallback(() => {
    setRetro((prev) => !prev)
  }, [])

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
      <div className="absolute right-2 top-2 flex gap-1">
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          onClick={toggleRetro}
          aria-pressed={retro}
          aria-label={retro ? 'Turn retro monochrome mode off' : 'Turn retro monochrome mode on'}
          title={
            retro ? 'Retro mode on — monochrome (click for color)' : 'Retro mode off — color (click for monochrome)'
          }
          className={cn('opacity-60 hover:opacity-100', retro && 'text-brand opacity-100')}
        >
          <Tv className="size-4" />
        </Button>
        {fullscreenHref && (
          <Button
            asChild
            variant="secondary"
            size="icon-sm"
            className="opacity-60 hover:opacity-100"
            title="Fullscreen"
          >
            <Link to={fullscreenHref} aria-label="Open terminal fullscreen">
              <Maximize2 className="size-4" />
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
