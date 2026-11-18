/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Minimal Chrome DevTools Protocol driver (no dependencies; Node 22+ global WebSocket).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Chrome is found from CHROME_BIN, then the usual install paths. No npm dependency is needed.
const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const BIN = CANDIDATES.find((candidate) => existsSync(candidate))
if (!BIN) {
  throw new Error('No Chrome found. Set CHROME_BIN to a Chrome or chrome-headless-shell binary.')
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ port = 9344, profileDir }) {
  mkdirSync(profileDir, { recursive: true })
  const child = spawn(
    BIN,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--hide-scrollbars=false',
      '--force-device-scale-factor=1',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let targets
  for (let i = 0; i < 50; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (targets.some((t) => t.type === 'page')) break
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message))
      else res(msg.result)
    } else if (msg.method) {
      for (const l of listeners) l(msg)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      id += 1
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')
  const consoleErrors = []
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        `EXC ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`.slice(0, 400),
      )
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrors.push(
        `${m.params.type.toUpperCase()} ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(
          0,
          400,
        ),
      )
    }
  })

  const api = {
    send,
    consoleErrors,
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    },
    async initScript(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source })
    },
    async goto(url) {
      await send('Page.navigate', { url })
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) {
        throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      }
      return r.result.value
    },
    async shot(file, { full = false } = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })
      writeFileSync(file, Buffer.from(r.data, 'base64'))
    },
    async key(key, code = key, keyCode = 0, modifiers = 0) {
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    },
    async hover(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    },
    async close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      child.kill('SIGKILL')
    },
  }
  return api
}
