// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { OrganizationPlan, Plan } from '@/billing-api'
import { PlanCards, PlanCardsSkeleton } from './PlanCards'

const plans: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    priceMonthlyCents: 1900,
    includedQuotaCents: 3000,
    concurrencyLimit: 20,
    selfServe: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyCents: 14900,
    includedQuotaCents: 25000,
    concurrencyLimit: 100,
    selfServe: true,
  },
]
const subscription: OrganizationPlan = {
  planId: 'starter',
  planName: 'Starter',
  status: 'active',
  cycleFrom: new Date('2026-11-01T00:00:00Z'),
  cycleTo: new Date('2026-12-01T00:00:00Z'),
  includedQuotaCents: 3000,
  quotaConsumedCents: 0,
  quotaRemainingCents: 3000,
}

function Location() {
  return <output>{useLocation().pathname}</output>
}

describe('PlanCards surfaces and actions', () => {
  let root: Root | undefined
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    document.body.innerHTML = ''
  })

  function render(children: ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter>
          {children}
          <Location />
        </MemoryRouter>,
      )
    })
    return host
  }

  it('reserves the top rule for the current plan and keeps upgrade navigation', () => {
    const host = render(<PlanCards plans={plans} organizationPlan={subscription} />)
    const cards = [...(host.firstElementChild?.children ?? [])]
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      expect(card.classList.contains('border')).toBe(false)
      expect(card.classList.contains('border-t-2')).toBe(true)
      expect(card.querySelector('.divide-y')).toBeNull()
    }
    expect(cards[0].classList.contains('border-foreground/45')).toBe(true)
    expect(cards[0].textContent).toContain('current')
    expect(cards[0].querySelector('button')?.disabled).toBe(true)
    expect(cards[1].classList.contains('border-transparent')).toBe(true)
    expect(cards[1].textContent).toContain('$149/mo')
    expect(cards[1].textContent).toContain('100 boxes')
    expect(cards[2].classList.contains('border-transparent')).toBe(true)
    expect(cards[2].textContent).toContain('by request')
    expect(cards[2].querySelector('a')?.href).toMatch(/^mailto:sales@boxlite\.ai\?/)

    const upgrade = cards[1].querySelector('button')
    expect(upgrade?.textContent).toContain('Upgrade')
    expect(upgrade?.disabled).toBe(false)
    act(() => upgrade?.click())
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/billing/plan/pro')
  })

  it('keeps loading surfaces borderless before plan data arrives', () => {
    const host = render(<PlanCardsSkeleton count={4} />)
    const cards = [...(host.firstElementChild?.children ?? [])]
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.classList.contains('bg-card')).toBe(true)
      expect(card.classList.contains('border')).toBe(false)
    }
  })
})
