/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Bridge for the sandbox-controlled terminal iframe.
 *
 * Only the bounded font-size scalar is forwarded on the iframe URL. User
 * snippets or custom key sequences stay out of URL/query/postMessage paths.
 */

const FONT_SIZE_KEY = 'boxlite.terminal.fontSize'

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
// receive paste replies with a precise targetOrigin. Registration is not a
// user gesture, so iframe-originated messages never trigger clipboard reads.
const activeTerminalFrames = new Map<Window, string>()

export function registerActiveTerminalFrame(frame: Window, sessionUrl: string): () => void {
  if (typeof window === 'undefined') return () => {}
  let origin: string
  try {
    origin = new URL(sessionUrl).origin
  } catch {
    return () => {}
  }
  activeTerminalFrames.set(frame, origin)
  return () => {
    if (activeTerminalFrames.get(frame) === origin) activeTerminalFrames.delete(frame)
  }
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
    const registeredOrigin = activeTerminalFrames.get(senderFrame)
    if (!registeredOrigin) return
    if (event.origin !== registeredOrigin) return

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

    if (msg.type === 'ready') {
      // Handshake ping only; no user-supplied terminal data is sent back.
      return
    }

    // In particular, iframe-originated paste requests are ignored.
  })
}

/**
 * Triggered by a dashboard-rendered Paste button. Because the click handler
 * runs in the dashboard document, `navigator.clipboard.readText()` carries
 * the dashboard's user activation. The text is posted to the registered
 * iframe origin, never `'*'`.
 *
 * Clickjacking defence: if the dashboard itself is framed by a third party,
 * a malicious parent could overlay this button and trick the user into
 * leaking their host clipboard. Refuse to read clipboard from a framed
 * dashboard. Deployments should also enforce CSP `frame-ancestors 'none'`
 * (or `X-Frame-Options: DENY`) on the dashboard HTML response; this
 * runtime check is defence in depth, not a substitute.
 */
export async function pasteIntoTerminalIframe(frame: Window, sessionUrl: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
  if (typeof window !== 'undefined' && window.top !== window.self) return
  // Prefer the origin recorded at iframe load; sessionUrl is only a pre-load fallback.
  let targetOrigin = activeTerminalFrames.get(frame)
  if (!targetOrigin) {
    try {
      targetOrigin = new URL(sessionUrl).origin
    } catch {
      return
    }
  }
  let text: string
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // User denied, no user gesture propagated, or the API is unavailable.
    return
  }
  if (!text) return
  try {
    frame.postMessage({ source: 'boxlite-terminal', type: 'paste', text }, targetOrigin)
  } catch {
    /* Frame may have been closed between gesture and reply. */
  }
}
