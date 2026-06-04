/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ClipboardPaste, Maximize2 } from 'lucide-react'
import { useEffect, useRef, type SyntheticEvent } from 'react'
import { Link } from 'react-router-dom'
import { buildTerminalIframeSrc, pasteIntoTerminalIframe, registerActiveTerminalFrame } from './terminalIframeSrc'

interface SandboxTerminalFrameProps {
  sessionUrl: string
  fullscreenHref?: string
  className?: string
}

export function SandboxTerminalFrame({ sessionUrl, fullscreenHref, className }: SandboxTerminalFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const deregisterRef = useRef<(() => void) | null>(null)
  const iframeSrc = buildTerminalIframeSrc(sessionUrl)

  const handlePaste = async () => {
    const frame = frameRef.current?.contentWindow
    if (!frame) return
    await pasteIntoTerminalIframe(frame, sessionUrl)
  }

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
        ref={frameRef}
        title="Sandbox terminal"
        src={iframeSrc}
        onLoad={handleLoad}
        className="absolute inset-0 h-full w-full border-0 bg-black"
      />
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        className={cn('absolute top-2 opacity-60 hover:opacity-100', fullscreenHref ? 'right-12' : 'right-2')}
        title="Paste from clipboard"
        aria-label="Paste from clipboard"
        onClick={handlePaste}
      >
        <ClipboardPaste className="size-4" />
      </Button>
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
