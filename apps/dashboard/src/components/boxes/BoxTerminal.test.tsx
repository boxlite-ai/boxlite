// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxTerminal } from './BoxTerminal'

const mocks = vi.hoisted(() => ({
  api: {
    startTerminalExec: vi.fn(),
    terminalAttachUrl: vi.fn(),
    killTerminalExec: vi.fn(),
  },
  fit: vi.fn(),
  focus: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  bottom: vi.fn(),
  options: { fontSize: 13, disableStdin: false, fontFamily: '' },
  input: undefined as ((data: string) => void) | undefined,
  resized: undefined as (() => void) | undefined,
}))

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      mocks.fit()
    }
  },
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: typeof mocks.options) {
      mocks.options = options
    }
    get options() {
      return mocks.options
    }
    cols = 80
    rows = 24
    loadAddon() {}
    open(container: HTMLElement) {
      const screen = document.createElement('div')
      screen.dataset.testid = 'terminal-screen'
      container.appendChild(screen)
    }
    focus() {
      mocks.focus()
    }
    write(data: unknown) {
      mocks.write(data)
    }
    clear() {
      mocks.clear()
    }
    scrollToBottom() {
      mocks.bottom()
    }
    dispose() {
      mocks.dispose()
    }
    onResize(callback: () => void) {
      mocks.resized = callback
      return { dispose() {} }
    }
    onData(callback: (data: string) => void) {
      mocks.input = callback
      return { dispose() {} }
    }
  },
}))

/** A WebSocket whose events the test fires; `close()` is silent, as the browser's close event comes later. */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send = vi.fn()
  close() {
    this.readyState = 3
  }
}

/** Lets the component's pending promises settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BoxTerminal', () => {
  let container: HTMLDivElement
  let root: Root
  let resize: () => void
  let frames: Map<number, FrameRequestCallback>

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }))
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
    frames = new Map()
    let nextFrame = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback)
        return nextFrame
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
    FakeSocket.instances = []
    mocks.api.startTerminalExec.mockReset().mockResolvedValue('exec-1')
    mocks.api.terminalAttachUrl.mockReset().mockResolvedValue('ws://api.test/attach?ticket=t')
    mocks.api.killTerminalExec.mockReset().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.documentElement.style.removeProperty('--font-mono')
    document.body.style.overflow = ''
    document.documentElement.style.scrollbarGutter = ''
  })

  function render() {
    act(() => root.render(<BoxTerminal boxId="box-1" />))
  }

  function open() {
    const socket = FakeSocket.instances.at(-1)!
    socket.readyState = 1
    act(() => socket.onopen?.())
    return socket
  }

  function flushFrames() {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach((callback) => callback(0)))
  }

  function reconnect() {
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!.click())
  }

  it('loads the configured font without replacing the active shell', async () => {
    let loaded!: (faces: FontFace[]) => void
    const load = vi.fn().mockReturnValue(
      new Promise<FontFace[]>((resolve) => {
        loaded = resolve
      }),
    )
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load } })
    document.documentElement.style.setProperty('--font-mono', '"Commit Mono", monospace')
    render()
    await settle()
    open()
    flushFrames()
    mocks.fit.mockClear()
    expect(load).toHaveBeenCalledWith('13px "Commit Mono", monospace')
    expect(mocks.options.fontFamily).toBe('ui-monospace, monospace')
    loaded([{} as FontFace])
    await settle()
    flushFrames()
    expect(mocks.options.fontFamily).toBe('"Commit Mono", monospace')
    expect(mocks.fit).toHaveBeenCalledTimes(1)
    expect(mocks.api.startTerminalExec).toHaveBeenCalledTimes(1)
    expect(mocks.api.killTerminalExec).not.toHaveBeenCalled()
  })

  it('keeps the active shell and fallback when font delivery fails', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Font unavailable'))
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load } })
    document.documentElement.style.setProperty('--font-mono', '"Commit Mono", monospace')
    render()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
    expect(mocks.options.fontFamily).toBe('ui-monospace, monospace')
    expect(FakeSocket.instances).toHaveLength(1)
    expect(mocks.api.killTerminalExec).not.toHaveBeenCalled()
  })

  it('ignores a font load that completes after unmount', async () => {
    let loaded!: (faces: FontFace[]) => void
    const load = vi.fn().mockReturnValue(
      new Promise<FontFace[]>((resolve) => {
        loaded = resolve
      }),
    )
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve(), load } })
    document.documentElement.style.setProperty('--font-mono', '"Commit Mono", monospace')
    render()
    await settle()
    act(() => root.unmount())
    const fits = mocks.fit.mock.calls.length
    loaded([{} as FontFace])
    await settle()
    flushFrames()
    expect(mocks.options.fontFamily).toBe('ui-monospace, monospace')
    expect(mocks.fit).toHaveBeenCalledTimes(fits)
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
  })

  // The old socket's close event lands after the new attempt has started, so
  // it must not mark that attempt as failed.
  it('keeps a reconnect connecting when the old socket closes late', async () => {
    render()
    await settle()
    const first = FakeSocket.instances[0]
    act(() => first.onmessage?.({ data: JSON.stringify({ type: 'exit', exit_code: 0 }) }))
    expect(container.textContent).toMatch(/session ended/i)

    reconnect()
    act(() => first.onclose?.())

    expect(container.textContent).not.toContain('could not connect')
    expect(container.textContent).toMatch(/connecting/i)
  })

  // A shell nobody can reach again would otherwise sit in the box until the
  // runner's idle reaper, once per mount, refresh and reconnect.
  it('ends the shell when the terminal unmounts', async () => {
    render()
    await settle()

    act(() => root.unmount())

    expect(mocks.api.killTerminalExec).toHaveBeenCalledWith('org-1', 'box-1', 'exec-1')
  })

  it('ends a shell that finishes starting after the terminal is gone', async () => {
    let started: (execId: string) => void = () => {}
    mocks.api.startTerminalExec.mockReturnValue(new Promise<string>((resolve) => (started = resolve)))
    render()

    act(() => root.unmount())
    started('exec-2')
    await settle()

    expect(mocks.api.terminalAttachUrl).not.toHaveBeenCalled()
    expect(mocks.api.killTerminalExec).toHaveBeenCalledWith('org-1', 'box-1', 'exec-2')
  })

  it('reports a lost connection separately from a shell exit', async () => {
    render()
    await settle()
    act(() => open().onclose?.())
    expect(container.textContent).toContain('Connection lost')
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
  })

  it('releases the shell when attach-ticket acquisition fails', async () => {
    mocks.api.terminalAttachUrl.mockRejectedValue(new Error('ticket refused'))
    render()
    await settle()
    expect(mocks.api.killTerminalExec).toHaveBeenCalledWith('org-1', 'box-1', 'exec-1')
  })

  it('ignores old socket opens and output after reconnect', async () => {
    render()
    await settle()
    const old = open()
    act(() => old.onmessage?.({ data: JSON.stringify({ type: 'exit', exit_code: 0 }) }))
    reconnect()
    await settle()
    act(() => {
      old.onopen?.()
      old.onmessage?.({ data: new Uint8Array([1, 65]).buffer })
    })
    expect(container.textContent).toMatch(/connecting/i)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('times out a pending start at 30 seconds and releases its late shell', async () => {
    vi.useFakeTimers()
    let started!: (id: string) => void
    mocks.api.startTerminalExec.mockReturnValue(
      new Promise<string>((resolve) => {
        started = resolve
      }),
    )
    render()
    act(() => vi.advanceTimersByTime(29_999))
    expect(container.textContent).toMatch(/connecting/i)
    act(() => vi.advanceTimersByTime(1))
    expect(container.textContent).toContain('Connection timed out')
    started('late-exec')
    await settle()
    expect(mocks.api.terminalAttachUrl).not.toHaveBeenCalled()
    expect(mocks.api.killTerminalExec).toHaveBeenCalledWith('org-1', 'box-1', 'late-exec')
  })

  it('releases a timed-out ticket attempt once without attaching late', async () => {
    vi.useFakeTimers()
    let ticket!: (url: string) => void
    mocks.api.terminalAttachUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        ticket = resolve
      }),
    )
    render()
    await settle()
    act(() => vi.advanceTimersByTime(30_000))
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
    ticket('ws://api.test/late')
    await settle()
    expect(FakeSocket.instances).toHaveLength(0)
    act(() => root.unmount())
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
  })

  it('coalesces resize notifications into one animation frame', async () => {
    render()
    await settle()
    flushFrames()
    mocks.fit.mockClear()
    act(() => {
      resize()
      resize()
      resize()
    })
    expect(mocks.fit).not.toHaveBeenCalled()
    flushFrames()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
  })

  it('skips hidden terminal geometry and cancels pending resize on unmount', async () => {
    render()
    await settle()
    flushFrames()
    mocks.fit.mockClear()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0)
    act(() => resize())
    flushFrames()
    expect(mocks.fit).not.toHaveBeenCalled()
    act(() => resize())
    act(() => root.unmount())
    expect(frames.size).toBe(0)
  })

  it('treats closing before open as a failed connection', async () => {
    render()
    await settle()
    const socket = FakeSocket.instances[0]
    socket.readyState = 3
    act(() => socket.onclose?.())
    expect(container.textContent).toContain('Could not connect')
  })

  it('refits when browser fonts become ready without reconnecting', async () => {
    let ready!: () => void
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          ready = resolve
        }),
      },
    })
    render()
    await settle()
    flushFrames()
    mocks.fit.mockClear()
    ready()
    await settle()
    flushFrames()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
    expect(mocks.api.startTerminalExec).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit exit final during a reentrant close and disables further input', async () => {
    render()
    await settle()
    const socket = open()
    vi.spyOn(socket, 'close').mockImplementation(() => {
      socket.readyState = 3
      socket.onclose?.()
    })
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'exit', exit_code: 0 }) }))
    expect(container.textContent).toContain('Session ended')
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
    expect(mocks.options.disableStdin).toBe(true)
    socket.send.mockClear()
    act(() => mocks.input?.('ignored'))
    expect(socket.send).not.toHaveBeenCalled()
  })

  it.each(['protocol', 'socket'])('ends a failed %s attach and exposes reconnect', async (kind) => {
    render()
    await settle()
    const socket = open()
    act(() =>
      kind === 'protocol'
        ? socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'attach refused' }) })
        : socket.onerror?.(),
    )
    expect(container.textContent).toContain('Could not connect')
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
    if (kind === 'protocol') expect(mocks.write).toHaveBeenCalledWith('\r\nattach refused\r\n')
  })

  it('times out a WebSocket handshake but leaves an open session running', async () => {
    vi.useFakeTimers()
    render()
    await settle()
    act(() => vi.advanceTimersByTime(30_000))
    expect(container.textContent).toContain('Connection timed out')
    expect(FakeSocket.instances[0].readyState).toBe(3)
    reconnect()
    await settle()
    open()
    const released = mocks.api.killTerminalExec.mock.calls.length
    act(() => vi.advanceTimersByTime(60_000))
    expect(container.textContent).toContain('Connected')
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(released)
  })

  it('preserves binary input, output and deduplicated JSON resize frames', async () => {
    render()
    await settle()
    const socket = open()
    flushFrames()
    act(() => {
      resize()
      mocks.resized?.()
    })
    flushFrames()
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'resize', cols: 80, rows: 24 })
    act(() => mocks.input?.('ls\r'))
    expect(socket.send).toHaveBeenLastCalledWith(new TextEncoder().encode('ls\r'))
    act(() => socket.onmessage?.({ data: new Uint8Array([1, 65, 66]).buffer }))
    expect(mocks.write).toHaveBeenCalledWith(new Uint8Array([65, 66]))
  })

  // New UI contracts: these controls had no equivalent in the base component.
  it('changes text size, clears and scrolls without replacing the shell', async () => {
    render()
    await settle()
    const socket = open()
    const sizes = container.querySelector<HTMLElement>('[aria-label="Terminal text size"]')
    expect(sizes).not.toBeNull()
    for (const size of ['12', '16']) {
      await act(async () => sizes?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      expect(choices.map((option) => option.textContent)).toEqual(['12 px', '13 px', '14 px', '16 px'])
      await act(async () => choices.find((option) => option.textContent === `${size} px`)?.click())
      expect(mocks.options.fontSize).toBe(Number(size))
    }
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear terminal"]')!.click())
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]')!.click())
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    expect(mocks.bottom).toHaveBeenCalledTimes(1)
    expect(mocks.api.startTerminalExec).toHaveBeenCalledTimes(1)
    act(() => socket.onclose?.())
    reconnect()
    await settle()
    expect(mocks.options.fontSize).toBe(16)
  })
  it('maximizes and restores without replacing the terminal, buffer or shell', async () => {
    render()
    await settle()
    const socket = open()
    flushFrames()
    const region = container.querySelector('[aria-label="Box terminal"]')
    const screen = container.querySelector('[data-testid="terminal-screen"]')
    const background = document.createElement('button')
    const alreadyInert = document.createElement('div')
    alreadyInert.setAttribute('inert', '')
    container.append(background, alreadyInert)
    document.body.style.overflow = 'auto'
    document.documentElement.style.scrollbarGutter = 'stable'
    mocks.focus.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Maximize terminal"]')?.click())
    expect(mocks.focus).toHaveBeenCalledTimes(1)
    expect(region?.getAttribute('data-maximized')).toBe('true')
    expect(background.hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    act(() => {
      resize()
      mocks.input?.('echo preserved\r')
    })
    flushFrames()
    expect(socket.send).toHaveBeenLastCalledWith(new TextEncoder().encode('echo preserved\r'))
    mocks.focus.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Restore terminal"]')?.click())
    expect(mocks.focus).toHaveBeenCalledTimes(1)
    expect(region?.hasAttribute('data-maximized')).toBe(false)
    expect(container.querySelector('[aria-label="Box terminal"]')).toBe(region)
    expect(container.querySelector('[data-testid="terminal-screen"]')).toBe(screen)
    expect(background.hasAttribute('inert')).toBe(false)
    expect(alreadyInert.hasAttribute('inert')).toBe(true)
    expect(document.body.style.overflow).toBe('auto')
    expect(document.documentElement.style.scrollbarGutter).toBe('stable')
    expect(mocks.api.startTerminalExec).toHaveBeenCalledTimes(1)
    expect(mocks.api.killTerminalExec).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.dispose).not.toHaveBeenCalled()
  })

  it('restores covered controls and page scrolling when maximized Terminal unmounts', async () => {
    render()
    await settle()
    const background = document.createElement('button')
    container.append(background)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Maximize terminal"]')?.click())
    expect(background.hasAttribute('inert')).toBe(true)
    await act(async () => root.unmount())
    expect(background.hasAttribute('inert')).toBe(false)
    expect(document.body.style.overflow).toBe('')
    expect(mocks.api.killTerminalExec).toHaveBeenCalledTimes(1)
  })
})
