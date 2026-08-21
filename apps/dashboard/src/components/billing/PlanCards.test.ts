/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { planCardDisplay } from './PlanCards'

describe('PR 829 real-data parity: plan cards', () => {
  it('formats the catalog tier and leverage without adding API fields', () => {
    expect(
      planCardDisplay(
        {
          id: 'pro',
          name: 'Pro',
          priceMonthlyCents: 14_900,
          includedQuotaCents: 25_000,
          concurrencyLimit: 100,
          selfServe: true,
        },
        1,
      ),
    ).toEqual({
      tierLabel: 'T2',
      leverage: '1.67×',
    })
  })

  it('does not invent leverage for an unpriced or unlimited catalog entry', () => {
    expect(
      planCardDisplay(
        {
          id: 'managed',
          name: 'Managed',
          priceMonthlyCents: null,
          includedQuotaCents: null,
          concurrencyLimit: null,
          selfServe: false,
        },
        3,
      ),
    ).toEqual({
      tierLabel: 'T4',
      leverage: '—',
    })
  })
})
