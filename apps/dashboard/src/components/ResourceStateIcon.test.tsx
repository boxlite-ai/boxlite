// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BoxState, type Box } from '@boxlite-ai/api-client'
import { BoxResourceIcon, DomainResourceIcon, VolumeResourceIcon } from './ResourceStateIcon'
import { BoxStatusIndicator } from './boxes/box-presentation'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('updates a mounted Box icon and its readable status together without replacing its identity', () => {
  const render = (state: BoxState) => {
    const box = { state } as Box
    act(() =>
      root.render(
        <>
          <BoxResourceIcon box={box} />
          <BoxStatusIndicator box={box} />
        </>,
      ),
    )
  }
  render(BoxState.STARTING)
  const icon = host.querySelector('svg')
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
  expect(icon?.getAttribute('focusable')).toBe('false')
  expect(host.textContent).toBe('Starting')
  expect(icon?.querySelector('.resource-state-trace')).not.toBeNull()
  render(BoxState.STARTED)
  expect(host.querySelector('svg')).toBe(icon)
  expect(icon?.querySelector('.resource-state-trace')).toBeNull()
  expect(host.textContent).toBe('Running')
  expect(host.querySelector('.resource-status [aria-hidden]')).not.toBeNull()
  render(BoxState.ERROR)
  expect(host.querySelector('svg')).toBe(icon)
  expect(host.textContent).toBe('Error')
  expect(icon?.querySelector('.resource-state-trace')).toBeNull()
})

it('only pulses an executing volume, stopping after completion or failure', () => {
  for (const [state, active] of [
    ['pending_create', false],
    ['creating', true],
    ['ready', false],
    ['pending_delete', false],
    ['deleting', true],
    ['error', false],
  ] as const) {
    act(() => root.render(<VolumeResourceIcon state={state} />))
    expect(Boolean(host.querySelector('.resource-state-breathe'))).toBe(active)
  }
})

it('keeps bound and unbound domain icons stationary and decorative', () => {
  for (const bound of [false, true]) {
    act(() => root.render(<DomainResourceIcon bound={bound} />))
    expect(host.querySelector('.resource-state-trace,.resource-state-breathe')).toBeNull()
    expect(Boolean(host.querySelector('.resource-state-accent'))).toBe(bound)
    expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  }
})
