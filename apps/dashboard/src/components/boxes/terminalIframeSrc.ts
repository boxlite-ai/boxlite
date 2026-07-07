/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Bridge for the box-controlled terminal iframe.
 *
 * Only the bounded font-size scalar is forwarded on the iframe URL. The
 * parent page may send the fixed "ls" command to a registered terminal frame
 * after file uploads so the visible shell refreshes in its current directory.
 */

const FONT_SIZE_KEY = 'boxlite.terminal.fontSize'
export const TERMINAL_FILE_DRAG_EVENT = 'boxlite.terminal-file-drag'

function readNumber(key: string, min: number, max: number): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < min || n > max) return null
    return n
  } catch {
    return null
  }
}

export function buildTerminalIframeSrc(baseUrl: string): string {
  if (typeof window === 'undefined') return baseUrl
  ensureTerminalPrefListener()
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return baseUrl
  }

  // Only the non-sensitive font-size scalar is allowed on the URL.
  // See module docstring for the sensitivity classification.
  const fs = readNumber(FONT_SIZE_KEY, 8, 32)
  if (fs !== null) url.searchParams.set('fs', String(fs))

  return url.toString()
}

let listenerInstalled = false

// Registered iframe windows are allowed to persist non-sensitive prefs and
// receive bounded dashboard commands with a precise targetOrigin. Registration
// is not a user gesture, so iframe-originated messages never trigger clipboard
// reads.
interface ActiveTerminalFrame {
  onCurrentDirChange?: (path: string) => void
  origin: string
}

const activeTerminalFrames = new Map<Window, ActiveTerminalFrame>()
let currentTerminalFrame: Window | null = null

export function registerActiveTerminalFrame(
  frame: Window,
  sessionUrl: string,
  options: { onCurrentDirChange?: (path: string) => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => {}
  ensureTerminalPrefListener()
  let origin: string
  try {
    origin = new URL(sessionUrl).origin
  } catch {
    return () => {}
  }
  activeTerminalFrames.set(frame, {
    onCurrentDirChange: options.onCurrentDirChange,
    origin,
  })
  currentTerminalFrame = frame
  frame.postMessage(
    {
      source: 'boxlite-dashboard',
      type: 'cwd-request',
    },
    origin,
  )
  return () => {
    if (activeTerminalFrames.get(frame)?.origin === origin) activeTerminalFrames.delete(frame)
    if (currentTerminalFrame === frame) currentTerminalFrame = null
  }
}

export function sendActiveTerminalListCommand(): boolean {
  if (typeof window === 'undefined') return false

  const frame = currentTerminalFrame
  if (!frame) return false

  const registeredFrame = activeTerminalFrames.get(frame)
  if (!registeredFrame) return false

  frame.postMessage(
    {
      source: 'boxlite-dashboard',
      type: 'command',
      command: 'ls',
    },
    registeredFrame.origin,
  )
  return true
}

function ensureTerminalPrefListener() {
  if (listenerInstalled || typeof window === 'undefined') return
  listenerInstalled = true
  window.addEventListener('message', (event) => {
    const data = event.data as unknown
    if (!data || typeof data !== 'object') return
    const msg = data as {
      source?: unknown
      type?: unknown
      key?: unknown
      value?: unknown
    }
    if (msg.source !== 'boxlite-terminal') return

    const senderFrame = event.source as Window | null
    if (!senderFrame) return
    const registeredFrame = activeTerminalFrames.get(senderFrame)
    if (!registeredFrame) return
    if (event.origin !== registeredFrame.origin) return

    if (msg.type === 'pref') {
      if (msg.key === 'fontSize' && typeof msg.value === 'number' && msg.value >= 8 && msg.value <= 32) {
        try {
          window.localStorage.setItem(FONT_SIZE_KEY, String(Math.round(msg.value)))
        } catch {
          /* localStorage may be blocked; persistence is best effort. */
        }
      }
      return
    }

    if (msg.type === 'cwd') {
      if (typeof msg.value === 'string' && isSafeAbsoluteBoxPath(msg.value)) {
        registeredFrame.onCurrentDirChange?.(msg.value)
      }
      return
    }

    if (msg.type === 'file-drag') {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_FILE_DRAG_EVENT, {
          detail: { active: msg.value === 'active' },
        }),
      )
      return
    }

    if (msg.type === 'ready') {
      // Handshake ping only; no user-supplied terminal data is sent back.
      return
    }

    // In particular, iframe-originated paste requests are ignored.
  })
}

function isSafeAbsoluteBoxPath(value: string): boolean {
  return value.startsWith('/') && value.length <= 4096 && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 31 || code === 127) return true
  }
  return false
}
