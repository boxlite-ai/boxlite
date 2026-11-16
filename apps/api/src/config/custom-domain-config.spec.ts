/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { customDomainConfig } from './custom-domain-config'

describe('custom domain deployment configuration', () => {
  const valid = {
    CUSTOM_DOMAIN_GCP_PROJECT: 'boxlite-dev-project',
    CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP: 'boxlite-app-dev-proxy',
    PROXY_DOMAIN: 'proxy.example.com:443',
  }
  it('leaves custom-domain onboarding disabled without provider settings', () => {
    expect(customDomainConfig({ PROXY_DOMAIN: 'localhost:28080' }).enabled).toBe(false)
  })
  it('requires all deployment resources together', () => {
    for (const key of Object.keys(valid)) {
      expect(() => customDomainConfig({ ...valid, [key]: '' })).toThrow()
    }
  })
  it('uses the proxy hostname without its port', () => {
    expect(customDomainConfig(valid)).toMatchObject({ enabled: true, trafficHost: 'proxy.example.com' })
  })
  it.each(['https://example.com', '127.0.0.1', 'example.com:65536', '-invalid.example.com', 'x..example.com'])(
    'refuses an invalid traffic hostname %s',
    (host) => {
      expect(() => customDomainConfig({ ...valid, PROXY_DOMAIN: host })).toThrow()
    },
  )
})
