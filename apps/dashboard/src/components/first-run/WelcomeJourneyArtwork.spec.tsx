// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WelcomeJourneyArtwork from './WelcomeJourneyArtwork'
import type { WelcomeBoxPhase } from './WelcomeBoxIllustration'

let host: HTMLDivElement
let root: Root | null
let main: HTMLElement
let form: HTMLFormElement
let anchor: HTMLDivElement
let observers: Array<{
  resize: () => void
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}>

function bounds(left: number, top: number, width: number, height = 400): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  main = document.createElement('main')
  main.style.paddingLeft = '20px'
  form = document.createElement('form')
  main.append(form)
  anchor = document.createElement('div')
  document.body.append(host, main, anchor)
  root = createRoot(host)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(bounds(20, 30, 1200))
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(bounds(100, 80, 1100))
  vi.spyOn(form, 'getBoundingClientRect').mockReturnValue(bounds(580, 150, 480))
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(bounds(250, 300, 420))
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      resize: () => void
      constructor(callback: ResizeObserverCallback) {
        this.resize = () => callback([], this as unknown as ResizeObserver)
        observers.push(this)
      }
    },
  )
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host.remove()
  main.remove()
  anchor.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(
  step: WelcomeBoxPhase = 'organization',
  mainElement: HTMLElement | null = main,
  creditsAnchor: HTMLDivElement | null = null,
) {
  await act(async () =>
    root!.render(
      <WelcomeJourneyArtwork step={step} selection={null} mainElement={mainElement} creditsAnchor={creditsAnchor} />,
    ),
  )
}

function artwork() {
  return host.querySelector<HTMLDivElement>('.welcome-journey-art')!
}

it('centers a capped illustration in the space beside the padded form and repositions on resize', async () => {
  await render()
  expect(artwork().style.visibility).toBe('visible')
  expect(artwork().style.transform).toBe('translate3d(92px, 176px, 0) scale(0.9047619047619048)')
  expect(host.querySelector('.welcome-journey-backdrop')?.getAttribute('data-step')).toBe('organization')
  expect(observers[0].observe.mock.calls).toEqual([[host], [main]])

  vi.mocked(form.getBoundingClientRect).mockReturnValue(bounds(370, 170, 480))
  act(() => observers[0].resize())
  expect(artwork().style.transform).toBe('translate3d(72px, 196px, 0) scale(0.5)')

  const changes: MutationRecord[] = []
  const mutations = new MutationObserver((records) => changes.push(...records))
  mutations.observe(artwork(), { attributes: true })
  act(() => observers[0].resize())
  await Promise.resolve()
  expect(changes).toHaveLength(0)
  mutations.disconnect()
})

it('moves the same Box to the credits anchor and follows anchor resizes', async () => {
  await render('intent')
  const svg = host.querySelector('.welcome-box-artwork')
  const formObserver = observers[0]

  await render('credits', main, anchor)
  expect(formObserver.disconnect).toHaveBeenCalledTimes(1)
  expect(host.querySelector('.welcome-box-artwork')).toBe(svg)
  expect(svg?.getAttribute('data-phase')).toBe('credits')
  expect(artwork().style.transform).toBe('translate3d(230px, 270px, 0) scale(1)')
  expect(observers[1].observe.mock.calls).toEqual([[host], [main], [anchor]])

  vi.mocked(anchor.getBoundingClientRect).mockReturnValue(bounds(310, 330, 210))
  act(() => observers[1].resize())
  expect(artwork().style.transform).toBe('translate3d(290px, 300px, 0) scale(0.5)')

  await act(async () => root!.unmount())
  root = null
  expect(observers[1].disconnect).toHaveBeenCalledTimes(1)
})

it('waits for the main element and credits anchor before revealing the illustration', async () => {
  await render('credits', null)
  expect(artwork().style.visibility).toBe('hidden')
  expect(artwork().style.transform).toBe('')
  expect(observers).toHaveLength(0)

  await render('credits', main)
  expect(artwork().style.visibility).toBe('hidden')
  expect(observers).toHaveLength(0)

  await render('credits', main, anchor)
  expect(artwork().style.visibility).toBe('visible')
  expect(artwork().style.transform).toBe('translate3d(230px, 270px, 0) scale(1)')
})

it('places the artwork without ResizeObserver and recalculates when the step changes', async () => {
  vi.stubGlobal('ResizeObserver', undefined)
  await render()
  expect(artwork().style.transform).toBe('translate3d(92px, 176px, 0) scale(0.9047619047619048)')

  vi.mocked(form.getBoundingClientRect).mockReturnValue(bounds(370, 170, 480))
  await render('intent')
  expect(artwork().style.transform).toBe('translate3d(72px, 196px, 0) scale(0.5)')
  expect(observers).toHaveLength(0)
})

it('keeps the artwork at zero width until a form has available space', async () => {
  form.remove()
  main.removeAttribute('style')
  await render()
  expect(artwork().style.transform).toBe('translate3d(52px, 56px, 0) scale(0)')

  main.append(form)
  act(() => observers[0].resize())
  expect(artwork().style.transform).toBe('translate3d(82px, 176px, 0) scale(0.9047619047619048)')
})
