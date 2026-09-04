/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { promises as dns } from 'dns'
import { resolveAllowNetHostnames } from './resolve-allow-net'

describe('resolveAllowNetHostnames', () => {
  afterEach(() => jest.restoreAllMocks())

  it('passes CIDR entries through unchanged', async () => {
    expect(await resolveAllowNetHostnames(['10.0.0.0/8'])).toEqual(['10.0.0.0/8'])
  })

  it('appends /32 to bare IPv4 addresses', async () => {
    expect(await resolveAllowNetHostnames(['1.2.3.4'])).toEqual(['1.2.3.4/32'])
  })

  // Security-relevant: a hostname becomes concrete /32s so egress is bound to
  // real IPs instead of trusting a guest-supplied SNI/Host (audit finding #1).
  it('resolves hostnames to /32 CIDRs', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['203.0.113.10', '203.0.113.11'])
    expect(await resolveAllowNetHostnames(['api.openai.com'])).toEqual(['203.0.113.10/32', '203.0.113.11/32'])
  })

  it('drops hostnames that fail to resolve rather than failing the create', async () => {
    jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENOTFOUND'))
    expect(await resolveAllowNetHostnames(['nope.invalid'])).toEqual([])
  })

  it('caps the expanded list at the allow_net entry limit', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(Array.from({ length: 15 }, (_, i) => `10.0.0.${i}`))
    expect(await resolveAllowNetHostnames(['many.example.com'])).toHaveLength(10)
  })

  it('handles a mix of CIDR, IPv4 and hostname entries', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['198.51.100.5'])
    expect(await resolveAllowNetHostnames(['10.0.0.0/8', '1.2.3.4', 'host.example.com'])).toEqual([
      '10.0.0.0/8',
      '1.2.3.4/32',
      '198.51.100.5/32',
    ])
  })
})
