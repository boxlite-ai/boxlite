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

const renderSegmented = () => renderVariant('segmented')

describe('segmented tabs', () => {
  it('marks the selected tab with brand, not the neutral hover tint', () => {
    // `--accent` is the hover tint and sits ~4 lightness points off the surface
    // it renders on, so it cannot carry selection. A brand tint can.
    const { active } = renderSegmented()

    expect(active.className).toContain('data-[state=active]:bg-[hsl(var(--brand)/0.12)]')
    expect(active.className).not.toContain('data-[state=active]:bg-accent')
    // A 0.12 tint alone measures 1.12:1 — about what `bg-accent` managed — so
    // the inset rule is what actually makes the selected segment findable.
    expect(active.className).toContain('data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--brand))]')
  })

  it('keeps the selected label readable on the light theme', () => {
    // `--brand` is a light cyan: as a text colour it measures ~2.2:1 on the
    // light theme's white surface, which would make the selected segment the
    // hardest label on the strip to read. Brand carries the fill, not the text.
    const { active } = renderSegmented()

    expect(active.className).toContain('data-[state=active]:text-foreground')
    expect(active.className).not.toContain('data-[state=active]:text-brand')
  })

  it('leaves the neutral tint to hover', () => {
    const { inactive } = renderSegmented()

    expect(inactive.className).toContain('hover:bg-accent')
  })
})

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
