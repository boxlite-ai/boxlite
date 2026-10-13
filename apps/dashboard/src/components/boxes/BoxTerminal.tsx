/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Maximize2 } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { decodeAttachFrame } from './attachFrame'

type Status = 'connecting' | 'open' | 'exited' | 'failed'

const STATUS_LINE: Record<Exclude<Status, 'open'>, string> = {
  connecting: 'connecting…',
  exited: 'session ended',
  failed: 'could not connect',
}

/**
 * An interactive shell in the box: a TTY execution over the `/v1` attach
 * WebSocket (stdin as binary frames; stdout as `[channel][bytes]`; resize as
 * a JSON text frame). Closing the page leaves the execution to the runner's
 * idle reaper; connecting again starts a fresh shell.
 */
export function BoxTerminal({
  boxId,
  fullscreenHref,
  className,
}: {
  boxId: string
  fullscreenHref?: string
  className?: string
}) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !organizationId) return
    let disposed = false
    let socket: WebSocket | undefined
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#000000' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    fit.fit()
    setStatus('connecting')

    const sendResize = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    }
    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(container)
    const onResize = terminal.onResize(sendResize)
    const encoder = new TextEncoder()
    const onData = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data))
    })

    void (async () => {
      try {
        const execId = await api.startTerminalExec(organizationId, boxId)
        const url = await api.terminalAttachUrl(organizationId, boxId, execId)
        if (disposed) return
        socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => {
          setStatus('open')
          sendResize()
          terminal.focus()
        }
        socket.onmessage = (event) => {
          const frame = decodeAttachFrame(event.data)
          if (frame.kind === 'output') terminal.write(frame.bytes)
          else if (frame.kind === 'exit') setStatus('exited')
          else if (frame.kind === 'error') terminal.write(`\r\n${frame.message}\r\n`)
        }
        socket.onclose = () =>
          setStatus((current) => (current === 'open' || current === 'exited' ? 'exited' : 'failed'))
      } catch {
        if (!disposed) setStatus('failed')
      }
    })()

    return () => {
      disposed = true
      socket?.close()
      resizeObserver.disconnect()
      onResize.dispose()
      onData.dispose()
      terminal.dispose()
    }
  }, [api, boxId, organizationId, attempt])

  return (
    <div className={cn('relative min-h-0 bg-black', className)}>
      <div ref={containerRef} className="absolute inset-0 p-2" />
      {status !== 'open' && (
        <div className="absolute bottom-2 left-2 flex items-center gap-3 font-mono text-meta text-muted-foreground">
          <span>{STATUS_LINE[status]}</span>
          {status !== 'connecting' && (
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              reconnect
            </Button>
          )}
        </div>
      )}
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
