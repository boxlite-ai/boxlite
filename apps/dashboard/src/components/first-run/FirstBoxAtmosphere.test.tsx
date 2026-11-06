// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import FirstBoxAtmosphere from './FirstBoxAtmosphere'
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))
let root: Root, host: HTMLDivElement
let next: FrameRequestCallback | undefined
const ctx = { clearRect: vi.fn(), fillText: vi.fn(), setTransform: vi.fn() }
const disconnect = vi.fn()
let reduced = false,
  wide = true
let changes: (() => void)[]
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  reduced = false
  wide = true
  changes = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return (
      this.tagName === 'MAIN'
        ? { left: 400, right: 1000, top: 100, bottom: 600, width: 600, height: 500 }
        : { left: 0, top: 0, width: 1440, height: 1000 }
    ) as DOMRect
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('reduced') ? reduced : wide
    },
    addEventListener: (_: string, cb: () => void) => changes.push(cb),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect = disconnect
    },
  )
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      next = cb
      return 1
    }),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function mount() {
  await act(async () =>
    root.render(
      <FirstBoxAtmosphere>
        <main>Form</main>
      </FirstBoxAtmosphere>,
    ),
  )
}
it('draws outside the form, animates pointer spawns and releases observers on unmount', async () => {
  await mount()
  next!(0)
  expect(ctx.fillText).toHaveBeenCalled()
  for (const [, x, y] of ctx.fillText.mock.calls) expect(x < 390 || x > 1010 || y < 100 || y > 600).toBe(true)
  const container = host.firstElementChild!
  container.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 200 }))
  host.querySelector('main')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  next!(100)
  next!(150)
  next!(1000)
  next!(13000)
  expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(2)
  await act(async () => root.unmount())
  expect(disconnect).toHaveBeenCalledOnce()
  expect(cancelAnimationFrame).toHaveBeenCalled()
  root = createRoot(host)
})
it('renders once with reduced motion and suspends when the viewport narrows', async () => {
  reduced = true
  await mount()
  const initial = next!
  next = undefined
  initial(0)
  expect(ctx.fillText).toHaveBeenCalled()
  expect(next).toBeUndefined()
  const count = ctx.clearRect.mock.calls.length
  wide = false
  changes[0]()
  expect(ctx.clearRect).toHaveBeenCalledTimes(count)
})
it('keeps the form usable when canvas is unavailable', async () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
  await mount()
  expect(host.textContent).toBe('Form')
  expect(requestAnimationFrame).not.toHaveBeenCalled()
})

it('renders the form without starting the canvas when the journey supplies its own artwork', async () => {
  await act(async () =>
    root.render(
      <FirstBoxAtmosphere animated={false}>
        <main>Organization form</main>
      </FirstBoxAtmosphere>,
    ),
  )
  expect(host.querySelector('main')?.textContent).toBe('Organization form')
  expect(host.querySelector('canvas')).toBeNull()
  expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled()
  expect(requestAnimationFrame).not.toHaveBeenCalled()

  await mount()
  expect(host.querySelector('canvas')).not.toBeNull()
  expect(requestAnimationFrame).toHaveBeenCalled()
})
