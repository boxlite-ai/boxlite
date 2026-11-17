// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import Redeem from './Redeem'

function LocationProbe() {
  const location = useLocation()
  return <output>{location.pathname + location.search}</output>
}

describe('Redeem link', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function visit(entry: string) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/redeem" element={<Redeem />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    return host.querySelector('output')?.textContent
  }

  it('opens the Wallet tab with the promo code from the link', () => {
    expect(visit('/redeem?code=ACME50')).toBe('/dashboard/billing?tab=wallet&code=ACME50')
  })

  it('keeps a code that needs URL encoding intact', () => {
    expect(visit('/redeem?code=A%26B%20C')).toBe('/dashboard/billing?tab=wallet&code=A%26B+C')
  })

  it('opens the Wallet tab without a code when the link has none', () => {
    expect(visit('/redeem')).toBe('/dashboard/billing?tab=wallet')
  })
})
