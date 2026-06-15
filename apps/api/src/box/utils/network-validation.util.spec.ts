/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { isValidNetworkAllowEntry, validateNetworkAllowList } from './network-validation.util'

describe('network allow list validation', () => {
  it.each(['api.openai.com', '*.anthropic.com', '192.168.1.1', '10.0.0.0/8'])(
    'accepts supported allow_net entry %s',
    (entry) => {
      expect(isValidNetworkAllowEntry(entry)).toBe(true)
    },
  )

  it.each(['', 'https://api.openai.com', '*example.com', 'api..openai.com', '10.0.0.0/33', '999.0.0.1'])(
    'rejects invalid allow_net entry %s',
    (entry) => {
      expect(isValidNetworkAllowEntry(entry)).toBe(false)
    },
  )

  it('accepts comma-separated allow_net lists with hostnames, wildcards, IPs, and CIDRs', () => {
    expect(() => validateNetworkAllowList('api.openai.com, *.anthropic.com, 192.168.1.1, 10.0.0.0/8')).not.toThrow()
  })

  it('rejects more than ten allow_net entries', () => {
    const entries = Array.from({ length: 11 }, (_, index) => `api-${index}.example.com`).join(',')

    expect(() => validateNetworkAllowList(entries)).toThrow('more than 10 networks')
  })

  it('rejects invalid comma-separated allow_net entries', () => {
    expect(() => validateNetworkAllowList('api.openai.com,10.0.0.0/33')).toThrow('Invalid network allow list entry')
  })
})
