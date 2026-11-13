/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { ArrowDown, RefreshCw, Trash2 } from '@/components/ui/icon'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { decodeAttachFrame } from './attachFrame'

type Status = 'connecting' | 'open' | 'exited' | 'failed' | 'lost' | 'timed-out'

const STATUS_LINE: Record<Status, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  exited: 'Session ended',
  failed: 'Could not connect',
  lost: 'Connection lost',
  'timed-out': 'Connection timed out',
}
const FONT_SIZES = [12, 13, 14, 16]

/**
 * An interactive shell in the box: a TTY execution over the `/v1` attach
 * WebSocket (stdin as binary frames; stdout as `[channel][bytes]`; resize as
 * a JSON text frame). Unmounting ends the shell; closing the page leaves it
 * to the runner, which ends it once it has had no client for 5 minutes.
 * Connecting again starts a fresh shell.
 */
export function BoxTerminal({ boxId, className }: { boxId: string; className?: string }) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const refitRef = useRef<(() => void) | null>(null)
  const fontSizeRef = useRef(13)
  const [status, setStatus] = useState<Status>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !organizationId) return
    let disposed = false
    let stopped = false
    let opened = false
    let socket: WebSocket | undefined
    let execId: string | undefined
    const endShell = (id: string) => void api.killTerminalExec(organizationId, boxId, id).catch(() => {})
    const releaseShell = () => {
      if (!execId) return
      const id = execId
      execId = undefined
      endShell(id)
    }
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontSize: fontSizeRef.current,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      theme: { background: '#000000' },
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    setStatus('connecting')

    let sentSize = ''
    const sendResize = () => {
      const size = `${terminal.cols}:${terminal.rows}`
      if (
        !stopped &&
        socket?.readyState === WebSocket.OPEN &&
        container.clientWidth > 0 &&
        container.clientHeight > 0 &&
        size !== sentSize
      ) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
        sentSize = size
      }
    }
    let resizeFrame: number | undefined
    // Measure after layout settles, once per frame; hidden tabs must not resize the guest to minimum geometry.
    const scheduleFit = () => {
      if (disposed || resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return
        fit.fit()
        sendResize()
      })
    }
    refitRef.current = scheduleFit
    scheduleFit()
    void document.fonts?.ready.then(scheduleFit)
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(container)
    const onResize = terminal.onResize(sendResize)
    const encoder = new TextEncoder()
    const onData = terminal.onData((data) => {
      if (!stopped && socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data))
    })
    const finish = (next: Exclude<Status, 'connecting' | 'open'>) => {
      if (stopped) return
      // Mark stopped first: close events and pending API results may arrive during cleanup.
      stopped = true
      clearTimeout(connectionTimer)
      terminal.options.disableStdin = true
      setStatus(next)
      socket?.close()
      releaseShell()
    }
    const connectionTimer = setTimeout(() => finish('timed-out'), 30_000)

    void (async () => {
      try {
        execId = await api.startTerminalExec(organizationId, boxId)
        // A late start still owns a shell, even after timeout or unmount.
        if (stopped) return releaseShell()
        const url = await api.terminalAttachUrl(organizationId, boxId, execId)
        if (stopped) return
        socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        socket.onopen = () => {
          if (stopped) return
          opened = true
          clearTimeout(connectionTimer)
          terminal.options.disableStdin = false
          setStatus('open')
          scheduleFit()
          terminal.focus()
        }
        socket.onmessage = (event) => {
          if (stopped) return
          const frame = decodeAttachFrame(event.data)
          if (frame.kind === 'output') terminal.write(frame.bytes)
          else if (frame.kind === 'exit') finish('exited')
          else if (frame.kind === 'error') {
            terminal.write(`\r\n${frame.message}\r\n`)
            finish('failed')
          }
        }
        // A socket closed by cleanup reports late, after the next attempt
        // has started; its close is not that attempt's failure.
        socket.onclose = () => finish(opened ? 'lost' : 'failed')
        socket.onerror = () => finish('failed')
      } catch {
        finish('failed')
      }
    })()

    return () => {
      disposed = true
      stopped = true
      clearTimeout(connectionTimer)
      socket?.close()
      releaseShell()
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeObserver.disconnect()
      onResize.dispose()
      onData.dispose()
      terminal.dispose()
      terminalRef.current = null
      refitRef.current = null
    }
  }, [api, boxId, organizationId, attempt])

  return (
    <div role="region" aria-label="Box terminal" className={cn('flex min-h-0 min-w-0 flex-col bg-black', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card p-2 font-sans text-meta text-foreground">
        <div role="status" className="flex min-w-0 grow items-center gap-2 whitespace-nowrap">
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0', status === 'open' ? 'bg-success' : 'bg-muted-foreground')}
          />
          <span>{STATUS_LINE[status]}</span>
        </div>
        <div role="group" aria-label="Terminal controls" className="flex flex-wrap items-center gap-1">
          {status !== 'connecting' && status !== 'open' && (
            <Button
              variant="outline"
              size="sm"
              title="Start a fresh shell session"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RefreshCw className="size-4" />
              Reconnect
            </Button>
          )}
          <select
            aria-label="Terminal text size"
            title="Terminal text size"
            defaultValue={13}
            className="h-7 border border-border bg-card px-1 text-meta focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
            onChange={(event) => {
              const size = Number(event.target.value)
              if (!FONT_SIZES.includes(size)) return
              fontSizeRef.current = size
              const terminal = terminalRef.current
              if (!terminal) return
              terminal.options.fontSize = size
              refitRef.current?.()
              terminal.focus()
            }}
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear terminal"
            title="Clear display and scrollback; keep the current line and shell"
            onClick={() => {
              terminalRef.current?.clear()
              terminalRef.current?.focus()
            }}
          >
            <Trash2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            onClick={() => {
              terminalRef.current?.scrollToBottom()
              terminalRef.current?.focus()
            }}
          >
            <ArrowDown className="size-4" />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 p-2" />
      </div>
    </div>
  )
}
