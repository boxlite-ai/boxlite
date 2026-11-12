/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { customDomainConfig } from './custom-domain-config'

describe('custom domain deployment configuration', () => {
  const valid = {
    CUSTOM_DOMAIN_GCP_PROJECT: 'boxlite-dev-project',
    CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP: 'boxlite-app-dev-proxy',
    CUSTOM_DOMAIN_TRAFFIC_HOST: 'custom.proxy.example.com',
  }
  it('leaves custom-domain onboarding disabled without provider settings', () => {
    expect(customDomainConfig({}).enabled).toBe(false)
  })
  it('requires all deployment resources together', () => {
    for (const key of Object.keys(valid)) {
      expect(() => customDomainConfig({ ...valid, [key]: '' })).toThrow()
    }
  })
  it('accepts the configured traffic hostname', () => {
    expect(customDomainConfig(valid)).toMatchObject({ enabled: true, trafficHost: valid.CUSTOM_DOMAIN_TRAFFIC_HOST })
  })
  it.each(['https://example.com', '127.0.0.1', 'example.com:443', '-invalid.example.com', 'x..example.com'])(
    'refuses an invalid traffic hostname %s',
    (host) => {
      expect(() => customDomainConfig({ ...valid, CUSTOM_DOMAIN_TRAFFIC_HOST: host })).toThrow()
    },
  )
})
