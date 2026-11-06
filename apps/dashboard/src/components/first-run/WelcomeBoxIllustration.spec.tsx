// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WelcomeBoxIllustration, { type WelcomeBoxPhase } from './WelcomeBoxIllustration'

const originalGetAnimations = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getAnimations')
let host: HTMLDivElement
let root: Root | null
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let getAnimations: ReturnType<typeof vi.fn>
let queries: Array<{
  media: string
  target: EventTarget
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}>

function cssAnimation(animationName: string) {
  return { animationName, updatePlaybackRate: vi.fn() }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  frames = new Map()
  nextFrame = 0
  queries = []
  getAnimations = vi.fn(() => [])
  Object.defineProperty(SVGElement.prototype, 'getAnimations', { configurable: true, value: getAnimations })
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
    'matchMedia',
    vi.fn((media: string) => {
      const target = new EventTarget()
      const query = {
        media,
        target,
        addEventListener: vi.fn(target.addEventListener.bind(target)),
        removeEventListener: vi.fn(target.removeEventListener.bind(target)),
      }
      queries.push(query)
      return query
    }),
  )
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host.remove()
  if (originalGetAnimations) Object.defineProperty(SVGElement.prototype, 'getAnimations', originalGetAnimations)
  else Reflect.deleteProperty(SVGElement.prototype, 'getAnimations')
  vi.unstubAllGlobals()
})

async function render(phase: WelcomeBoxPhase = 'credits', selection: string | null = null) {
  await act(async () => root!.render(<WelcomeBoxIllustration phase={phase} selection={selection} />))
}

function advanceFrame() {
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((callback) => callback(16)))
}

it.each([
  ['organization', 0.5],
  ['intent', 0.75],
  ['credits', 1],
] as const)('sets only looping animations to the %s phase rate', async (phase, rate) => {
  const loops = ['welcome-box-float', 'welcome-box-breathe', 'welcome-box-shadow'].map(cssAnimation)
  const entrance = cssAnimation('welcome-box-reveal')
  const selection = cssAnimation('welcome-box-select')
  const transition = { updatePlaybackRate: vi.fn() }
  getAnimations.mockReturnValue([...loops, entrance, selection, transition])

  await render(phase)
  advanceFrame()

  expect(host.querySelector('svg')?.dataset.phase).toBe(phase)
  expect(host.querySelector('svg')?.dataset.selected).toBe('false')
  expect(getAnimations).toHaveBeenCalledWith({ subtree: true })
  for (const animation of loops) expect(animation.updatePlaybackRate).toHaveBeenCalledExactlyOnceWith(rate)
  expect(entrance.updatePlaybackRate).not.toHaveBeenCalled()
  expect(selection.updatePlaybackRate).not.toHaveBeenCalled()
  expect(transition.updatePlaybackRate).not.toHaveBeenCalled()
})

it('replays the selected core while preserving the Box and retiming its new loop', async () => {
  await render('intent')
  advanceFrame()
  const svg = host.querySelector('svg')
  const oldSelection = host.querySelector('.welcome-box-selection')
  const breathe = cssAnimation('welcome-box-breathe')
  getAnimations.mockReturnValue([breathe])

  await render('intent', 'coding-agent')
  advanceFrame()

  expect(host.querySelector('svg')).toBe(svg)
  expect(svg?.dataset.selected).toBe('true')
  expect(host.querySelector('.welcome-box-selection')).not.toBe(oldSelection)
  expect(breathe.updatePlaybackRate).toHaveBeenCalledExactlyOnceWith(0.75)
})

it('coalesces media changes and applies the current phase to newly active animations', async () => {
  const firstLoop = cssAnimation('welcome-box-float')
  getAnimations.mockReturnValue([firstLoop])
  await render('organization')
  advanceFrame()
  const activeLoop = cssAnimation('welcome-box-shadow')
  getAnimations.mockReturnValue([activeLoop])

  expect(queries.map((query) => query.media)).toEqual([
    '(min-width: 1024px)',
    '(min-width: 1180px)',
    '(prefers-reduced-motion: reduce)',
  ])
  for (const query of queries) query.target.dispatchEvent(new Event('change'))
  expect(frames.size).toBe(1)
  expect(activeLoop.updatePlaybackRate).not.toHaveBeenCalled()
  advanceFrame()

  expect(getAnimations).toHaveBeenCalledTimes(2)
  expect(firstLoop.updatePlaybackRate).toHaveBeenCalledTimes(1)
  expect(activeLoop.updatePlaybackRate).toHaveBeenCalledExactlyOnceWith(0.5)
})

it('cancels the previous phase frame and releases media listeners on unmount', async () => {
  const loop = cssAnimation('welcome-box-float')
  getAnimations.mockReturnValue([loop])
  await render('organization')
  const oldQueries = [...queries]
  await render('credits')
  expect(frames.size).toBe(1)
  advanceFrame()
  expect(loop.updatePlaybackRate).toHaveBeenCalledExactlyOnceWith(1)
  for (const query of oldQueries) {
    expect(query.removeEventListener).toHaveBeenCalledWith('change', query.addEventListener.mock.calls[0][1])
  }

  queries.at(-1)!.target.dispatchEvent(new Event('change'))
  expect(frames.size).toBe(1)
  await act(async () => root!.unmount())
  root = null
  expect(frames.size).toBe(0)
  for (const query of queries) {
    expect(query.removeEventListener).toHaveBeenCalledWith('change', query.addEventListener.mock.calls[0][1])
    query.target.dispatchEvent(new Event('change'))
  }
  expect(frames.size).toBe(0)
  expect(loop.updatePlaybackRate).toHaveBeenCalledTimes(1)
})

it('keeps the illustration available without the Web Animations API', async () => {
  Reflect.deleteProperty(SVGElement.prototype, 'getAnimations')
  await render('credits')
  expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(host.querySelector('.welcome-box-core')).not.toBeNull()
  expect(requestAnimationFrame).not.toHaveBeenCalled()
  expect(matchMedia).not.toHaveBeenCalled()
})
