// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { optionalPublicOidcIssuer, requireOidcIssuer } from './oidc-issuer.mjs'

test('preserves each provider-defined HTTPS issuer exactly', () => {
  assert.equal(requireOidcIssuer({ OIDC_ISSUER_BASE_URL: 'https://tenant.auth0.com/' }), 'https://tenant.auth0.com/')
  assert.equal(
    requireOidcIssuer({ OIDC_ISSUER_BASE_URL: 'https://tenant.okta.com/oauth2/default' }),
    'https://tenant.okta.com/oauth2/default',
  )
  assert.equal(
    optionalPublicOidcIssuer({ PUBLIC_OIDC_DOMAIN: 'https://auth.dev.example.com/tenant' }),
    'https://auth.dev.example.com/tenant',
  )
})

test('requires the internal issuer and treats an empty public issuer as unset', () => {
  assert.throws(() => requireOidcIssuer({}), /OIDC_ISSUER_BASE_URL is required/)
  assert.equal(optionalPublicOidcIssuer({}), undefined)
  assert.equal(optionalPublicOidcIssuer({ PUBLIC_OIDC_DOMAIN: '' }), undefined)
})

test('rejects malformed or unsafe issuer URLs', () => {
  for (const value of [
    'tenant.auth0.com/',
    'http://tenant.auth0.com/',
    'https://user:password@tenant.auth0.com/',
    'https://tenant.auth0.com/?tenant=dev',
    'https://tenant.auth0.com/#issuer',
  ]) {
    assert.throws(() => requireOidcIssuer({ OIDC_ISSUER_BASE_URL: value }), /OIDC_ISSUER_BASE_URL/)
  }
})
