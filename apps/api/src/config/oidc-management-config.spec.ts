/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('OIDC Management API configuration', () => {
  const ENV_KEYS = [
    'OIDC_ISSUER_BASE_URL',
    'OID_ISSUER_BASE_URL',
    'OIDC_MANAGEMENT_API_ENABLED',
    'OIDC_MANAGEMENT_API_BASE_URL',
    'OIDC_MANAGEMENT_API_TOKEN_URL',
  ]
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

  function loadOidcConfiguration() {
    const { configuration } = require('./configuration') as typeof import('./configuration')
    return configuration.oidc
  }

  it.each([
    ['a trailing slash', 'https://tenant.auth0.com/'],
    ['no trailing slash', 'https://tenant.auth0.com'],
    ['a custom domain', 'https://login.example.com/'],
  ])('derives root-issuer management endpoints with %s without changing the issuer', (_case, issuer) => {
    process.env.OIDC_ISSUER_BASE_URL = issuer
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'

    const oidc = loadOidcConfiguration()

    expect(oidc.issuer).toBe(issuer)
    expect(oidc.managementApi).toEqual(
      expect.objectContaining({
        baseUrl: `${issuer.replace(/\/+$/, '')}/api/v2`,
        tokenUrl: `${issuer.replace(/\/+$/, '')}/oauth/token`,
      }),
    )
  })

  it('keeps the legacy issuer alias when deriving management endpoints', () => {
    process.env.OID_ISSUER_BASE_URL = 'https://legacy.example.com/'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'

    expect(loadOidcConfiguration()).toEqual(
      expect.objectContaining({
        issuer: 'https://legacy.example.com/',
        managementApi: expect.objectContaining({
          baseUrl: 'https://legacy.example.com/api/v2',
          tokenUrl: 'https://legacy.example.com/oauth/token',
        }),
      }),
    )
  })

  it('requires an issuer when management access is enabled', () => {
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'

    expect(() => loadOidcConfiguration()).toThrow(
      new Error('OIDC_ISSUER_BASE_URL is required when OIDC_MANAGEMENT_API_ENABLED is true'),
    )
  })

  it('requires explicit management endpoints for a path-based issuer', () => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'

    expect(() => loadOidcConfiguration()).toThrow(
      /OIDC_MANAGEMENT_API_BASE_URL is required when OIDC_MANAGEMENT_API_ENABLED is true with a path-based issuer/,
    )
  })

  it('requires an explicit token endpoint when a path-based issuer has a management base URL', () => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://management.example.com/admin'

    expect(() => loadOidcConfiguration()).toThrow(
      /OIDC_MANAGEMENT_API_TOKEN_URL is required when OIDC_MANAGEMENT_API_ENABLED is true with a path-based issuer/,
    )
  })

  it('normalizes an explicit API prefix but preserves the exact token endpoint', () => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://management.example.com/admin/'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL =
      'https://identity.example.com/realms/boxlite/protocol/openid-connect/token/?resource=management'

    expect(loadOidcConfiguration().managementApi).toEqual(
      expect.objectContaining({
        baseUrl: 'https://management.example.com/admin',
        tokenUrl: 'https://identity.example.com/realms/boxlite/protocol/openid-connect/token/?resource=management',
      }),
    )
  })

  it.each([
    [
      'OIDC_MANAGEMENT_API_BASE_URL',
      'https://management.example.com/admin?tenant=boxlite',
      'OIDC_MANAGEMENT_API_BASE_URL must not carry a query or fragment',
    ],
    [
      'OIDC_MANAGEMENT_API_TOKEN_URL',
      'https://identity.example.com/oauth/token#response',
      'OIDC_MANAGEMENT_API_TOKEN_URL must not carry a fragment',
    ],
  ])('rejects unsupported URL components in %s', (name, value, errorMessage) => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://management.example.com/admin'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL = 'https://identity.example.com/oauth/token'
    process.env[name] = value

    expect(() => loadOidcConfiguration()).toThrow(new Error(errorMessage))
  })

  it.each([
    ['OIDC_MANAGEMENT_API_BASE_URL', 'http://management.example.com/admin'],
    ['OIDC_MANAGEMENT_API_TOKEN_URL', 'http://identity.example.com/oauth/token'],
  ])('rejects plaintext transport for %s', (name, value) => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://management.example.com/admin'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL = 'https://identity.example.com/oauth/token'
    process.env[name] = value

    expect(() => loadOidcConfiguration()).toThrow(`${name} must use https`)
  })

  it.each([
    ['OIDC_MANAGEMENT_API_BASE_URL', '/admin'],
    ['OIDC_MANAGEMENT_API_TOKEN_URL', '/oauth/token'],
  ])('rejects a relative URL for %s', (name, value) => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env[name] = value

    expect(() => loadOidcConfiguration()).toThrow(`${name} must be an absolute https URL`)
  })

  it.each([
    ['OIDC_MANAGEMENT_API_BASE_URL', 'https://user:password@management.example.com/admin'],
    ['OIDC_MANAGEMENT_API_TOKEN_URL', 'https://user:password@identity.example.com/oauth/token'],
  ])('rejects credentials in %s', (name, value) => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'
    process.env.OIDC_MANAGEMENT_API_ENABLED = 'true'
    process.env.OIDC_MANAGEMENT_API_BASE_URL = 'https://management.example.com/admin'
    process.env.OIDC_MANAGEMENT_API_TOKEN_URL = 'https://identity.example.com/oauth/token'
    process.env[name] = value

    expect(() => loadOidcConfiguration()).toThrow(new Error(`${name} must not carry credentials`))
  })

  it('does not require management endpoints while the feature is disabled', () => {
    process.env.OIDC_ISSUER_BASE_URL = 'https://identity.example.com/realms/boxlite'

    expect(loadOidcConfiguration().managementApi.enabled).toBe(false)
  })
})
