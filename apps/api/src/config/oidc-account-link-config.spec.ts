/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('OIDC account link configuration', () => {
  const ENV_KEYS = [
    'OIDC_ACCOUNT_LINK_REDIRECT_SECRET',
    'OIDC_MANAGEMENT_API_ENABLED',
    'OIDC_CLIENT_ID',
    'OID_CLIENT_ID',
    'OIDC_ISSUER_BASE_URL',
    'OID_ISSUER_BASE_URL',
    'PUBLIC_OIDC_DOMAIN',
  ]
  const SECRET = 'x'.repeat(32)
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    jest.resetModules()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    jest.resetModules()
  })

  function loadAccountLinkConfiguration() {
    const { configuration } = require('./configuration') as typeof import('./configuration')
    return configuration.oidc.accountLink
  }

  function enable(issuer = 'https://tenant.us.auth0.com/') {
    process.env.OIDC_ACCOUNT_LINK_REDIRECT_SECRET = SECRET
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_CLIENT_ID = 'dashboard-spa'
    process.env.OIDC_ISSUER_BASE_URL = issuer
  }

  it('stays off, and demands nothing, while no secret is set', () => {
    expect(loadAccountLinkConfiguration()).toMatchObject({ enabled: false, redirectSecret: undefined })
  })

  it('derives every tenant endpoint from the issuer the browser uses', () => {
    enable('https://tenant.us.auth0.com/')
    process.env.PUBLIC_OIDC_DOMAIN = 'https://auth.dev.boxlite.ai/'

    expect(loadAccountLinkConfiguration()).toEqual({
      enabled: true,
      redirectSecret: SECRET,
      clientId: 'dashboard-spa',
      issuer: 'https://auth.dev.boxlite.ai/',
      authorizeUrl: 'https://auth.dev.boxlite.ai/authorize',
      tokenUrl: 'https://auth.dev.boxlite.ai/oauth/token',
      continueUrl: 'https://auth.dev.boxlite.ai/continue',
    })
  })

  it('falls back to the issuer when no public domain is published', () => {
    enable('https://tenant.us.auth0.com')

    expect(loadAccountLinkConfiguration().continueUrl).toBe('https://tenant.us.auth0.com/continue')
  })

  // Auth0 serves these at the root of its domain. A path-based issuer is some
  // other provider, or a proxy in front of one, and a guess there would send
  // the browser somewhere that is not the tenant.
  it.each([
    ['Dex under /dex', 'http://localhost:25556/dex'],
    ['Okta below /oauth2/default', 'https://tenant.okta.com/oauth2/default'],
  ])('refuses to boot on %s rather than guess its endpoints', (_case, issuer) => {
    // Through the public domain, which the link prefers: the internal issuer
    // stays a root one, so only this section's own guard can refuse it.
    enable()
    process.env.PUBLIC_OIDC_DOMAIN = issuer

    expect(() => loadAccountLinkConfiguration()).toThrow('not a path-based issuer')
  })

  it('refuses a key shorter than HS256 needs', () => {
    enable()
    process.env.OIDC_ACCOUNT_LINK_REDIRECT_SECRET = 'short'

    expect(() => loadAccountLinkConfiguration()).toThrow('at least 32 characters')
  })

  it('refuses to boot while the Management API it links through is off', () => {
    enable()
    delete process.env.OIDC_MANAGEMENT_API_ENABLED

    expect(() => loadAccountLinkConfiguration()).toThrow(
      'OIDC_MANAGEMENT_API_ENABLED must be true when OIDC_ACCOUNT_LINK_REDIRECT_SECRET is set',
    )
  })

  it('refuses to boot without the dashboard client the second sign-in goes through', () => {
    enable()
    delete process.env.OIDC_CLIENT_ID

    expect(() => loadAccountLinkConfiguration()).toThrow('OIDC_CLIENT_ID is required')
  })
})
