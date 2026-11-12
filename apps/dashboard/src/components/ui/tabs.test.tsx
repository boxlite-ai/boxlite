// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Tabs, TabsList, TabsTrigger, TRIGGER_BASE } from './tabs'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderVariant(variant: 'default' | 'underline' | 'segmented') {
  act(() => {
    root.render(
      <Tabs value="a">
        <TabsList variant={variant}>
          <TabsTrigger value="a">First</TabsTrigger>
          <TabsTrigger value="b">Second</TabsTrigger>
        </TabsList>
      </Tabs>,
    )
  })
  const triggers = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  return {
    active: triggers.find((t) => t.getAttribute('data-state') === 'active')!,
    inactive: triggers.find((t) => t.getAttribute('data-state') === 'inactive')!,
  }
}

// A variant written as a fresh copy of these classes loses whatever the author
// forgot; the `segmented` string dropped the focus ring, then `font-medium`,
// during review. Asserting the rendered class list against `TRIGGER_BASE`
// itself — not a list of classes someone remembered — fails for any variant
// that stops sharing the base.
describe.each(['default', 'underline', 'segmented'] as const)('%s tabs', (variant) => {
  it('renders every shared base class', () => {
    const { active, inactive } = renderVariant(variant)

    // `cn` is twMerge: a variant that sets its own vertical padding (underline)
    // legitimately drops the base's, so padding is the one class excluded.
    for (const cls of TRIGGER_BASE.split(' ').filter((cls) => !cls.startsWith('py-'))) {
      expect(active.className).toContain(cls)
      expect(inactive.className).toContain(cls)
    }
  })
})
