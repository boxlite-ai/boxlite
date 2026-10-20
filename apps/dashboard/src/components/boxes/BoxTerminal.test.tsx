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
}))

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onResize() {
      return { dispose() {} }
    }
    onData() {
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
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send() {}
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

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { OPEN: 1 }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
  })

  beforeEach(() => {
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
  })

  function render() {
    act(() => root.render(<BoxTerminal boxId="box-1" />))
  }

  // The old socket's close event lands after the new attempt has started, so
  // it must not mark that attempt as failed.
  it('keeps a reconnect connecting when the old socket closes late', async () => {
    render()
    await settle()
    const first = FakeSocket.instances[0]
    act(() => first.onmessage?.({ data: JSON.stringify({ type: 'exit', exit_code: 0 }) }))
    expect(container.textContent).toContain('session ended')

    act(() => (container.querySelector('button') as HTMLButtonElement).click())
    act(() => first.onclose?.())

    expect(container.textContent).not.toContain('could not connect')
    expect(container.textContent).toContain('connecting')
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
})
