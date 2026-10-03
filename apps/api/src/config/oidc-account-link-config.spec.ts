/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('OIDC account link configuration', () => {
  const ENV_KEYS = [
    'OIDC_ACCOUNT_LINK_REDIRECT_SECRET',
    'OIDC_ACCOUNT_LINK_CLIENT_ID',
    'OIDC_ACCOUNT_LINK_CLIENT_SECRET',
    'OIDC_MANAGEMENT_API_ENABLED',
    'OIDC_ISSUER_BASE_URL',
    'OID_ISSUER_BASE_URL',
    'PUBLIC_OIDC_DOMAIN',
    'OIDC_MANAGEMENT_API_BASE_URL',
    'OIDC_MANAGEMENT_API_TOKEN_URL',
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
    process.env.OIDC_ACCOUNT_LINK_CLIENT_ID = 'link-client'
    process.env.OIDC_ACCOUNT_LINK_CLIENT_SECRET = 'link-client-secret'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_ISSUER_BASE_URL = issuer
  }

  it('stays off, and demands nothing, while no secret is set', () => {
    expect(loadAccountLinkConfiguration()).toMatchObject({ enabled: false, redirectSecret: undefined })
  })

  it('checks passwords on the tenant domain and resumes the login on the public one', () => {
    enable('https://tenant.us.auth0.com/')
    process.env.PUBLIC_OIDC_DOMAIN = 'https://auth.dev.boxlite.ai/'

    expect(loadAccountLinkConfiguration()).toEqual({
      enabled: true,
      redirectSecret: SECRET,
      passwordClientId: 'link-client',
      passwordClientSecret: 'link-client-secret',
      issuer: 'https://tenant.us.auth0.com/',
      tokenUrl: 'https://tenant.us.auth0.com/oauth/token',
      signupUrl: 'https://tenant.us.auth0.com/dbconnections/signup',
      changePasswordUrl: 'https://tenant.us.auth0.com/dbconnections/change_password',
      continueUrl: 'https://auth.dev.boxlite.ai/continue',
    })
  })

  // The password never goes through a browser sign-in, so the paused login
  // loses nothing when both are the one domain a tenant without a custom
  // domain has.
  it('resumes on the issuer when no public domain is published', () => {
    enable('https://tenant.us.auth0.com')

    expect(loadAccountLinkConfiguration().continueUrl).toBe('https://tenant.us.auth0.com/continue')
  })

  // Auth0 serves these at the root of its domain. A path-based issuer is some
  // other provider, or a proxy in front of one, and a guess there would send
  // the browser somewhere that is not the tenant.
  it.each([
    ['Dex under /dex', 'http://localhost:25556/dex'],
    ['Okta below /oauth2/default', 'https://tenant.okta.com/oauth2/default'],
  ])('refuses to boot on %s as either domain rather than guess its endpoints', (_case, pathIssuer) => {
    enable()
    process.env.PUBLIC_OIDC_DOMAIN = pathIssuer
    expect(() => loadAccountLinkConfiguration()).toThrow('not a path-based issuer')

    // As the internal issuer, with the Management API pointed at explicitly
    // so only this section's own guard is left to refuse it.
    jest.resetModules()
    delete process.env.PUBLIC_OIDC_DOMAIN
    enable(pathIssuer)
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://tenant.us.auth0.com/api/v2'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL = 'https://tenant.us.auth0.com/oauth/token'
    expect(() => loadAccountLinkConfiguration()).toThrow('not a path-based issuer')
  })

  // The password and the link client's secret are posted to these endpoints.
  it.each(['OIDC_ISSUER_BASE_URL', 'PUBLIC_OIDC_DOMAIN'])('refuses to boot on a plain-http %s', (key) => {
    enable()
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://tenant.us.auth0.com/api/v2'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL = 'https://tenant.us.auth0.com/oauth/token'
    process.env[key] = 'http://tenant.us.auth0.com/'

    expect(() => loadAccountLinkConfiguration()).toThrow(`${key} must use https`)
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

  it.each(['OIDC_ACCOUNT_LINK_CLIENT_ID', 'OIDC_ACCOUNT_LINK_CLIENT_SECRET'])(
    'refuses to boot without %s, the client the password is checked through',
    (key) => {
      enable()
      delete process.env[key]

      expect(() => loadAccountLinkConfiguration()).toThrow(`${key} is required`)
    },
  )
})
