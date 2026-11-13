// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Checkpoint } from '@/api/checkpoint-types'
import { CheckpointGlyph, CheckpointStatusIndicator } from './CheckpointGlyph'

let root: Root
let host: HTMLDivElement
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
it('makes a failed checkpoint reason available on keyboard focus', async () => {
  act(() =>
    root.render(
      <CheckpointStatusIndicator
        checkpoint={{ state: 'failed', error_reason: 'Archive upload failed' } as Checkpoint}
      />,
    ),
  )
  const trigger = host.querySelector<HTMLElement>('[tabindex="0"]')!
  expect(trigger).not.toBeNull()
  expect(trigger.textContent).toBe('Failed')
  await act(async () => trigger.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Archive upload failed')
})
it.each(['ready', 'creating', 'deleting', 'failed'])('keeps %s status readable without a failure reason', (state) => {
  act(() => root.render(<CheckpointStatusIndicator checkpoint={{ state } as Checkpoint} />))
  expect(host.textContent?.toLowerCase()).toBe(state)
  expect(host.querySelector('[tabindex="0"]')).toBeNull()
  const marker = host.querySelector('[aria-hidden="true"]')!
  expect(marker).not.toBeNull()
  if (state === 'creating') expect(host.firstElementChild?.className).toContain('motion-reduce')
})
it('keeps the navigation glyph decorative without implying resource state', () => {
  act(() => root.render(<CheckpointGlyph />))
  expect(host.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(host.querySelector('path:last-child')?.getAttribute('stroke')).toBeNull()
})
