/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('BILLING_API_URL startup configuration', () => {
  const environmentKeys = ['BILLING_API_URL', 'USAGE_EXPORT_TOKEN'] as const
  const savedEnvironment: Partial<Record<(typeof environmentKeys)[number], string>> = {}

  beforeEach(() => {
    for (const key of environmentKeys) {
      savedEnvironment[key] = process.env[key]
      delete process.env[key]
    }
    jest.resetModules()
  })

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = savedEnvironment[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    jest.resetModules()
  })

  function loadBillingApiUrl(): string | undefined {
    const { configuration } = require('./configuration') as typeof import('./configuration')
    return configuration.billingApiUrl
  }

  it('keeps admission disabled when BILLING_API_URL is absent', () => {
    expect(loadBillingApiUrl()).toBeUndefined()
  })

  it.each([undefined, '   '])('refuses a configured Commerce URL with token %p', (token) => {
    process.env.BILLING_API_URL = 'https://commerce.test/api/billing'
    if (token !== undefined) {
      process.env.USAGE_EXPORT_TOKEN = token
    }

    expect(() => loadBillingApiUrl()).toThrow(/USAGE_EXPORT_TOKEN is required when BILLING_API_URL is set/)
  })

  it.each([
    ['a bare hostname', 'commerce.test', /absolute http\(s\) URL/],
    ['an unsupported scheme', 'ftp://commerce.test/api/billing', /must use http or https/],
    ['userinfo', 'https://user:secret@commerce.test/api/billing', /must not carry credentials/],
    ['a query', 'https://commerce.test/api/billing?tenant=one', /must not carry a query or fragment/],
    ['a fragment', 'https://commerce.test/api/billing#plans', /must not carry a query or fragment/],
  ])('refuses %s at startup', (_case, url, expected) => {
    process.env.BILLING_API_URL = url
    process.env.USAGE_EXPORT_TOKEN = 'shared-token'

    expect(() => loadBillingApiUrl()).toThrow(expected)
  })

  it.each([
    ['http for local development', 'http://commerce.test:3100/api/billing', 'http://commerce.test:3100/api/billing'],
    ['https', 'https://commerce.test/api/billing', 'https://commerce.test/api/billing'],
    ['a trailing slash', 'https://commerce.test/api/billing/', 'https://commerce.test/api/billing'],
  ])('accepts and normalizes %s', (_case, url, expected) => {
    process.env.BILLING_API_URL = url
    process.env.USAGE_EXPORT_TOKEN = 'shared-token'

    expect(loadBillingApiUrl()).toBe(expected)
  })
})
