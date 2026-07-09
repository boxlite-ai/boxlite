/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  getDomainContract,
  getDomainContractForStackDomain,
  getPrimaryLegacyApiBaseUrl,
  getUnprefixedApiHosts,
  withApiPrefix,
} from './index'

describe('domain contract', () => {
  it('defines canonical no-prefix API hosts and legacy prefixed API bases', () => {
    const dev = getDomainContract('development')
    const prod = getDomainContract('production')

    expect(dev.api.canonicalBaseUrl).toBe('https://api.dev.boxlite.ai')
    expect(dev.api.legacyBaseUrls).toContain('https://api.dev.boxlite.ai/api')
    expect(dev.api.legacyBaseUrls).toContain('https://dev.boxlite.ai/api')

    expect(prod.api.canonicalBaseUrl).toBe('https://api.boxlite.ai')
    expect(prod.api.legacyBaseUrls).toContain('https://api.app.boxlite.ai/api')
    expect(prod.api.legacyBaseUrls).toContain('https://api.boxlite.ai/api')
  })

  it('maps current stack domains to the target public contract', () => {
    expect(getDomainContractForStackDomain('dev.boxlite.ai').api.canonicalBaseUrl).toBe('https://api.dev.boxlite.ai')
    expect(getDomainContractForStackDomain('app.boxlite.ai').api.canonicalBaseUrl).toBe('https://api.boxlite.ai')
  })

  it('exposes explicit legacy and unprefixed API host helpers', () => {
    const prod = getDomainContract('production')

    expect(withApiPrefix(prod.api.canonicalBaseUrl)).toBe('https://api.boxlite.ai/api')
    expect(getPrimaryLegacyApiBaseUrl(prod)).toBe('https://api.app.boxlite.ai/api')
    expect(getUnprefixedApiHosts(prod)).toEqual(['api.boxlite.ai', 'api.app.boxlite.ai'])
  })
})
