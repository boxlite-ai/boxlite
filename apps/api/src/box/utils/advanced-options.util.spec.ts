/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { normalizeBoxAdvancedOptions } from './advanced-options.util'

describe('normalizeBoxAdvancedOptions', () => {
  it('rejects privileged mode combined with explicit capabilities', () => {
    expect(() =>
      normalizeBoxAdvancedOptions({
        privileged: true,
        capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] },
      }),
    ).toThrow(BadRequestError)
  })

  it('normalizes privileged mode without explicit capabilities', () => {
    expect(normalizeBoxAdvancedOptions({ privileged: true })).toEqual({
      privileged: true,
      capabilities: { add: ['ALL'], drop: [] },
    })
  })

  it('accepts the canonical privileged shape it produces, so normalizing twice is safe', () => {
    const normalized = normalizeBoxAdvancedOptions({ privileged: true })

    expect(normalizeBoxAdvancedOptions(normalized)).toEqual(normalized)
  })

  it('accepts a privileged request that already carries the canonical cap_add=ALL', () => {
    expect(
      normalizeBoxAdvancedOptions({
        privileged: true,
        capabilities: { add: ['ALL'], drop: [] },
      }),
    ).toEqual({ privileged: true, capabilities: { add: ['ALL'], drop: [] } })
  })

  it('canonicalizes capability spelling and removes semantic duplicates', () => {
    expect(
      normalizeBoxAdvancedOptions({
        capabilities: { add: ['cap_net_admin', 'NET_ADMIN'], drop: ['CAP_NET_RAW'] },
      }),
    ).toEqual({ privileged: false, capabilities: { add: ['NET_ADMIN'], drop: ['NET_RAW'] } })
  })

  it('accepts well-formed capability names for guest-side support validation', () => {
    expect(normalizeBoxAdvancedOptions({ capabilities: { add: ['FUTURE_KERNEL_CAPABILITY'] } })).toEqual({
      privileged: false,
      capabilities: { add: ['FUTURE_KERNEL_CAPABILITY'], drop: [] },
    })
  })

  it('rejects malformed capability names', () => {
    expect(() => normalizeBoxAdvancedOptions({ capabilities: { add: ['NET-ADMIN'] } })).toThrow(BadRequestError)
  })
})
