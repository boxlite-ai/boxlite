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

  it.each(['1', '65535'])('accepts the port boundary %s', (port) => {
    expect(domainConfig({ PROXY_APP_DOMAIN: `app.example.com:${port}` }).appDomain).toBe(`app.example.com:${port}`)
  })

  it.each(['65536', '99999'])('rejects out-of-range port %s', (port) => {
    expect(() => domainConfig({ PROXY_APP_DOMAIN: `app.example.com:${port}` })).toThrow('PROXY_APP_DOMAIN')
  })

  it('requires room for the configured minimum name within a 253-character hostname', () => {
    const fits = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(55)].join('.')
    expect(domainConfig({ PROXY_APP_DOMAIN: fits }).appHost).toBe(fits)
    expect(() => domainConfig({ PROXY_APP_DOMAIN: `${fits}d` })).toThrow('PROXY_APP_DOMAIN')
    expect(() => domainConfig({ PROXY_APP_DOMAIN: fits, PLATFORM_SUBDOMAIN_MIN_LENGTH: '6' })).toThrow(
      'PROXY_APP_DOMAIN',
    )
  })

  it('rejects a suffix containing a DNS label longer than 63 characters', () => {
    expect(() => domainConfig({ PROXY_APP_DOMAIN: `${'a'.repeat(64)}.example` })).toThrow('PROXY_APP_DOMAIN')
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
