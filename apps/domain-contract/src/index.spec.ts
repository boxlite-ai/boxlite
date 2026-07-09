/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  getDomainContract,
  getDomainContractForStackDomain,
  getPrimaryLegacyApiBaseUrl,
  getUnprefixedApiHosts,
  resolvePublicEndpointContract,
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
    expect(getUnprefixedApiHosts(prod)).toEqual(['api.boxlite.ai'])
  })

  it('keeps unprefixed API routing limited to the canonical API host', () => {
    const contract = resolvePublicEndpointContract({
      STACK_DOMAIN: 'dev.boxlite.ai',
      PUBLIC_API_BASE_URL: 'https://api.dev.boxlite.ai',
      PUBLIC_LEGACY_API_BASE_URLS: 'https://api.dev.boxlite.ai/api,https://dev.boxlite.ai/api',
    })

    expect(getUnprefixedApiHosts(contract)).toEqual(['api.dev.boxlite.ai'])
  })

  it('resolves an OSS deployment from standard PUBLIC_* env overrides', () => {
    const contract = resolvePublicEndpointContract({
      STACK_DOMAIN: 'example.com',
      PUBLIC_API_BASE_URL: 'https://api.example.com/',
      PUBLIC_DASHBOARD_BASE_URL: 'https://app.example.com/',
      PUBLIC_PROXY_DOMAIN: 'proxy.example.com',
      PUBLIC_SSH_GATEWAY_HOST: 'ssh.example.com',
      PUBLIC_SSH_GATEWAY_PORT: '2200',
      PUBLIC_LEGACY_API_BASE_URLS: 'https://legacy.example.com/api, https://api.example.com/api',
    })

    expect(contract.stackDomain).toBe('example.com')
    expect(contract.dashboard.canonicalUrl).toBe('https://app.example.com')
    expect(contract.api.canonicalBaseUrl).toBe('https://api.example.com')
    expect(contract.api.legacyBaseUrls).toEqual(['https://legacy.example.com/api', 'https://api.example.com/api'])
    expect(contract.proxy).toEqual({
      domain: 'proxy.example.com',
      wildcardDomain: '*.proxy.example.com',
      protocol: 'https',
      templateUrl: 'https://{{PORT}}-{{boxId}}.proxy.example.com',
      toolboxBaseUrl: 'https://proxy.example.com',
    })
    expect(contract.sshGateway).toEqual({
      host: 'ssh.example.com',
      port: 2200,
      url: 'ssh://ssh.example.com:2200',
    })
  })

  it('keeps legacy env names as fallback while preferring PUBLIC_* names', () => {
    const contract = resolvePublicEndpointContract({
      STACK_DOMAIN: 'example.com',
      PUBLIC_API_BASE_URL: 'https://api.new.example.com',
      PUBLIC_REST_API_BASE_URL: 'https://api.legacy.example.com/api',
      PROXY_DOMAIN: 'proxy.legacy.example.com',
      SSH_GATEWAY_URL: 'ssh://ssh.legacy.example.com:2222',
    })

    expect(contract.api.canonicalBaseUrl).toBe('https://api.new.example.com')
    expect(contract.api.legacyBaseUrls).toContain('https://api.legacy.example.com/api')
    expect(contract.proxy.domain).toBe('proxy.legacy.example.com')
    expect(contract.sshGateway.host).toBe('ssh.legacy.example.com')
  })

  it('does not treat DASHBOARD_URL as the canonical dashboard path', () => {
    const contract = resolvePublicEndpointContract({
      STACK_DOMAIN: 'dev.boxlite.ai',
      DASHBOARD_URL: 'https://dev.boxlite.ai',
    })

    expect(contract.dashboard.canonicalUrl).toBe('https://dev.boxlite.ai/dashboard')
  })
})
