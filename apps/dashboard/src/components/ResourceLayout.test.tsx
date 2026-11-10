// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ResourceEmptyState, StatusIndicator } from './ResourceLayout'

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

it('keeps optional empty-state guidance accessible and its icon decorative', () => {
  act(() => root.render(<ResourceEmptyState title="No resources" />))
  expect(host.querySelector('h2')?.textContent).toBe('No resources')
  expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull()
  expect(host.querySelector('a')).toBeNull()

  act(() =>
    root.render(
      <ResourceEmptyState title="No resources" description="Add a resource to start.">
        <a href="/dashboard/quickstart">Quickstart</a>
      </ResourceEmptyState>,
    ),
  )
  expect(host.textContent).toContain('Add a resource to start.')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/dashboard/quickstart')
  expect(host.querySelector('[aria-hidden="true"]')?.contains(host.querySelector('a'))).toBe(false)
})

it('normalizes machine status labels while preserving rich labels and accessibility props', () => {
  act(() => root.render(<StatusIndicator label="PENDING_DELETE" color="orange" aria-live="polite" />))
  expect(host.textContent).toBe('Pending delete')
  expect(host.querySelector('[aria-live="polite"]')).not.toBeNull()
  expect(host.querySelector('[aria-hidden="true"]')?.textContent).toBe('')

  act(() => root.render(<StatusIndicator label={<abbr title="Ready for use">Ready</abbr>} color="green" />))
  expect(host.querySelector('abbr')?.title).toBe('Ready for use')
  expect(host.textContent).toBe('Ready')
})
