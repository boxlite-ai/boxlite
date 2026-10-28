/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { domainConfig } from './configuration'

describe('domainConfig', () => {
  it('leaves the app domain unset and keeps the default minimum length', () => {
    expect(domainConfig({})).toEqual({ appDomain: undefined, appHost: undefined, platformSubdomainMinLength: 5 })
  })

  it('lowercases and trims the app domain', () => {
    const config = domainConfig({ PROXY_APP_DOMAIN: ' App.Dev.BoxLite.ai ' })
    expect(config.appDomain).toBe('app.dev.boxlite.ai')
    expect(config.appHost).toBe('app.dev.boxlite.ai')
  })

  // A local stack's proxy listens on a high port: the port belongs in the URL
  // the API mints, not in the hostname a name is stored under.
  it('keeps a port out of the host a name resolves under', () => {
    const config = domainConfig({ PROXY_APP_DOMAIN: 'app.localhost:4000' })
    expect(config.appDomain).toBe('app.localhost:4000')
    expect(config.appHost).toBe('app.localhost')
  })

  it.each([
    'app',
    'app..boxlite.ai',
    '-app.boxlite.ai',
    'https://app.boxlite.ai',
    'app.boxlite.ai:',
    'app.boxlite.ai:0',
  ])('rejects %s as an app domain', (value) => {
    expect(() => domainConfig({ PROXY_APP_DOMAIN: value })).toThrow('PROXY_APP_DOMAIN')
  })

  it.each([
    ['1', 1],
    ['63', 63],
    [' 7 ', 7],
  ])('accepts %s as the minimum length', (value, expected) => {
    expect(domainConfig({ PLATFORM_SUBDOMAIN_MIN_LENGTH: value }).platformSubdomainMinLength).toBe(expected)
  })

  it.each(['0', '64', '-1', '2.5', 'five'])('rejects %s as the minimum length', (value) => {
    expect(() => domainConfig({ PLATFORM_SUBDOMAIN_MIN_LENGTH: value })).toThrow('PLATFORM_SUBDOMAIN_MIN_LENGTH')
  })
})
